import { generateScript, type ScriptLine, type Slide, type VoiceMode } from '@/lib/ai/script';
import { normalizeLanguage } from '@/lib/language';
import { DEFAULT_VOICE_MODE } from '@/lib/settings/defaults';
import { synthesize } from '@/lib/ai/tts';
import { RetryableError, SCRIPT_MODEL } from '@/lib/ai/gemini';
import { TTS_MODEL } from '@/lib/ai/tts';
import { geminiKeyFor } from '@/lib/ai/keys';
import { recordUsage } from '@/lib/ai/usage';
import { complete, enqueueMany, fail, release, type Job } from '@/lib/jobs/queue';
import { fetchImageUrl } from '@/lib/feeds/image';
import { storeCover } from '@/lib/media/cover';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 音声化のジョブ2種。
 *
 *   script → 台本とスライドを作り、スライド1枚＝1セグメントに割って
 *            tts ジョブを撒く
 *   tts    → セグメント1つを合成して Storage に置く。全部揃ったら ready
 *
 * 合成をスライド単位にしているのは、クリップの切れ目をスライドの切り替わりに
 * 一致させるため（lib/ai/tts.ts）。おかげで再生側は時刻の計算を持たなくていい。
 */

const BUCKET = 'media';

/** 表紙を探すために og:image を読みに行く記事の数。絵の無いフィードで外部を叩きすぎない。 */
const COVER_LOOKUPS = 3;

/** 1回のワーカー実行で合成するセグメント数。無料枠の1日あたり回数を食い潰さない量。 */
export const TTS_PER_RUN = 4;

// ---------------------------------------------------------------- script

export async function runScriptJob(db: SupabaseClient, job: Job): Promise<boolean> {
  const mediaId = job.payload.media_id as string | undefined;
  if (!mediaId) {
    await complete(db, job.id);
    return false;
  }

  // 失敗の記録をどの鍵に付けるか。鍵を引く前に転んだら付けない。
  let keyOwner: string | null = null;
  try {
    const { data: media } = await db
      .from('media')
      .select('id, user_id, kind, article_id, digest_id, title, voice_mode')
      .eq('id', mediaId)
      .single();

    if (!media) {
      await complete(db, job.id);
      return false;
    }

    // 作らせた本人の鍵で作る（0046）。無ければ待っても動かないので、ここで止める。
    const apiKey = await geminiKeyFor(db, media.user_id);
    if (!apiKey) {
      await giveUpForMissingKey(db, job, mediaId);
      return false;
    }
    keyOwner = media.user_id;

    await db.from('media').update({ status: 'scripting' }).eq('id', mediaId);

    const source = await loadSource(db, media);
    // モードは media に焼いてある（create.ts が設定から写す）。ここで設定を
    // 見に行かないのは、生成中に設定を変えられると台本と声が食い違うため。
    const mode = (media.voice_mode ?? DEFAULT_VOICE_MODE) as VoiceMode;
    const { extra, language } = await scriptSettings(db, media.user_id);
    const { lines, slides, usage } = await generateScript(apiKey, source, extra, mode, language);
    await recordUsage(db, media.user_id, SCRIPT_MODEL, usage.inputTokens, usage.outputTokens, true);

    // 表紙。絵を持っている最初の記事のものを使う（ダイジェストなら選抜順の先頭）。
    // 台本ができてから取りに行く。台本が失敗する回のぶんまで相手のサイトを
    // 叩きたくないし、絵が取れなくても音声づくりは止めない。
    const coverPath = await storeCover(
      db,
      media.user_id,
      mediaId,
      await resolveCoverUrl(db, source.articles),
    );

    // スライド単位でまとめ、長いものはさらに分ける。これが合成の単位になる。
    const groups = groupIntoSegments(lines, slides.length);

    await db.from('media_segments').delete().eq('media_id', mediaId);
    const { error: segError } = await db.from('media_segments').insert(
      groups.map((g, idx) => ({
        media_id: mediaId,
        idx,
        slide_idx: g.slide,
        // 話者は1セグメントに2人ぶん入るので、行ごとの話者は text 側に残す。
        speaker: '',
        text: g.lines.map((l) => l.text).join('\n'),
      })),
    );
    if (segError) throw segError;

    const { error: updateError } = await db
      .from('media')
      .update({
        status: 'synthesizing',
        script: lines,
        slides,
        // 取れなかったときに null で潰さない。作り直しのたびに相手が
        // 落ちていると、前に取れていた表紙まで消える。
        ...(coverPath ? { cover_path: coverPath } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', mediaId);
    if (updateError) throw updateError;

    await enqueueMany(
      db,
      'tts',
      groups.map((_, idx) => ({ media_id: mediaId, idx })),
      media.user_id,
    );

    await complete(db, job.id);
    return true;
  } catch (err) {
    if (keyOwner) await recordUsage(db, keyOwner, SCRIPT_MODEL, 0, 0, false);
    await markFailed(db, mediaId, err);
    await fail(db, job.id, err);
    return false;
  }
}

// ---------------------------------------------------------------- tts

/**
 * @param hardDeadline これを過ぎたら合成を打ち切る時刻（epoch ms）。
 *   関数ごと落とされるより、打ち切ってジョブを戻すほうがはるかに速く復帰する。
 */
export async function runTtsJob(
  db: SupabaseClient,
  job: Job,
  hardDeadline: number,
): Promise<boolean> {
  const mediaId = job.payload.media_id as string | undefined;
  const idx = job.payload.idx as number | undefined;
  if (!mediaId || idx === undefined) {
    await complete(db, job.id);
    return false;
  }

  let keyOwner: string | null = null;
  try {
    const { data: media } = await db
      .from('media')
      .select('id, user_id, script, slides, voice_mode, voice_a, voice_b')
      .eq('id', mediaId)
      .single();
    const { data: segment } = await db
      .from('media_segments')
      .select('idx, slide_idx, audio_path')
      .eq('media_id', mediaId)
      .eq('idx', idx)
      .single();

    if (!media || !segment) {
      await complete(db, job.id);
      return false;
    }

    // 既に合成済みなら作り直さない（再実行で無料枠を無駄に使わないため）。
    if (segment.audio_path) {
      await complete(db, job.id);
      await finishIfDone(db, mediaId);
      return false;
    }

    // 割り方は台本とスライドから決まるので、script ジョブと同じ関数で引き直す。
    // セグメントの本文を別に持たせると、二重に持った片方だけが古くなる。
    const lines = (media.script ?? []) as ScriptLine[];
    const slides = (media.slides ?? []) as Slide[];
    const group = groupIntoSegments(lines, slides.length)[idx];

    if (!group || group.lines.length === 0) {
      await complete(db, job.id);
      return false;
    }

    const apiKey = await geminiKeyFor(db, media.user_id);
    if (!apiKey) {
      await giveUpForMissingKey(db, job, mediaId);
      return false;
    }
    keyOwner = media.user_id;

    const { mp3, durationSec, usage } = await synthesize(
      apiKey,
      group.lines,
      (media.voice_mode ?? DEFAULT_VOICE_MODE) as VoiceMode,
      { a: media.voice_a, b: media.voice_b },
      AbortSignal.timeout(Math.max(5_000, hardDeadline - Date.now())),
    );
    await recordUsage(db, media.user_id, TTS_MODEL, usage.inputTokens, usage.outputTokens, true);

    // パスの先頭を持ち主にしておくと、Storage 側の権限をフォルダ名だけで判定できる。
    const path = `${media.user_id}/${mediaId}/${idx}.mp3`;
    const { error: uploadError } = await db.storage
      .from(BUCKET)
      .upload(path, mp3, { contentType: 'audio/mpeg', upsert: true });
    if (uploadError) throw uploadError;

    const { error: segError } = await db
      .from('media_segments')
      .update({ audio_path: path, duration_sec: Number(durationSec.toFixed(2)) })
      .eq('media_id', mediaId)
      .eq('idx', idx);
    if (segError) throw segError;

    await complete(db, job.id);
    await finishIfDone(db, mediaId);
    return true;
  } catch (err) {
    // **打ち切りは失敗ではない。**時間が足りなかっただけなので、
    // バックオフも attempts も付けずにそのままキューへ戻す。
    // fail に回すと 3^attempts 分の待ちが入り、次の巡回で拾えなくなる。
    if (isAborted(err)) {
      await release(db, [job.id]);
      return false;
    }

    if (keyOwner) await recordUsage(db, keyOwner, TTS_MODEL, 0, 0, false);
    // 合成の失敗は1セグメントぶん。media 全体を落とさず、そのジョブだけ再試行する。
    await markFailed(db, mediaId, err, false);
    await fail(db, job.id, err);
    return false;
  }
}

/**
 * 生成中のまま、動かす人がいなくなった media を failed に落とす（`0027`）。
 *
 * markFailed は 429・503 のような「あとで再試行される類」で status を動かさない。
 * それ自体は正しい（1セグメント転んだだけで全体を殺さないため）が、**ジョブ側が
 * max_attempts で諦めたあとに media を落とす人がどこにもいなかった。**
 * その結果 /listen は ready でも failed でもない行を「合成中」として扱い、
 * できあがり予定時刻を永久に出し続ける。しかも failed ではないので
 * 作り直しの導線も出ない（実際に1本が8日間この状態で残った）。
 *
 * 判定はジョブ側に任せる。生きたジョブ（queued / running）が1つも無くなった
 * ときだけ落とす。ここで独自に「何分経ったら」と決めると、fail_job の
 * バックオフ（最大12時間）と食い違って、まだ生きているものを殺す。
 *
 * @returns 落とした本数
 */
export async function failAbandonedMedia(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('fail_abandoned_media');
  if (error) throw error;
  return (data as number) ?? 0;
}

/** 全セグメントが揃っていれば ready にして、合計の長さを入れる。 */
async function finishIfDone(db: SupabaseClient, mediaId: string): Promise<void> {
  const { data: segments } = await db
    .from('media_segments')
    .select('audio_path, duration_sec')
    .eq('media_id', mediaId);

  if (!segments || segments.length === 0) return;
  if (segments.some((s) => !s.audio_path)) return;

  const total = segments.reduce((sum, s) => sum + Number(s.duration_sec ?? 0), 0);

  await db
    .from('media')
    .update({
      status: 'ready',
      duration_sec: Math.round(total),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', mediaId);
}

/**
 * 鍵が無いので作れない。
 *
 * **再試行に回さないこと。** fail に回すとバックオフを挟んで何度も同じ理由で
 * 転び、そのあいだ画面は「生成中」のまま動かない。音声を落として、
 * 何をすれば作れるかを残す。鍵を入れたあとは「聴く」の作り直しから続きを作れる。
 */
async function giveUpForMissingKey(db: SupabaseClient, job: Job, mediaId: string) {
  await markFailed(
    db,
    mediaId,
    new Error('Gemini の API キーが設定されていません。設定画面で入れてから作り直してください'),
  );
  await complete(db, job.id);
}

/**
 * 失敗を media 側にも残す。
 *
 * 後で再試行される類の失敗（429・503）で status を failed にすると、
 * 実際にはキューが生きているのに画面上は死んで見える。理由だけ残して
 * 状態は据え置く。諦めたかどうかはジョブ側の attempts が決める（0002 の fail_job）。
 */
async function markFailed(
  db: SupabaseClient,
  mediaId: string | undefined,
  err: unknown,
  /**
   * false なら理由だけ残して状態は動かさない。
   * 合成はセグメント単位なので、1つ転んだだけで全体を落とすと、
   * 残りが順調でも画面上は死んで見える。
   */
  hard = true,
) {
  if (!mediaId) return;

  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  // 後で再試行される類（429・503）はキューが生きているので状態を据え置く。
  const giveUp = hard && !(err instanceof RetryableError);

  await db
    .from('media')
    .update({
      ...(giveUp ? { status: 'failed' } : {}),
      last_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', mediaId);
}

/**
 * 1セグメントに入れる台本の長さ。
 *
 * 実測で約450字が1分。1セグメントを1分半までに抑える。
 * スライドが1枚しか返らなかったとき（モデル次第で起こる）に、
 * 5分の音声を1回のTTSで作ろうとして、失敗したら全部やり直しになるのを防ぐ。
 * 短いほど再試行が安く、途中からの再生も効く。
 */
const MAX_SEGMENT_CHARS = 700;

/**
 * 発話をセグメントに割る。
 *
 * まずスライドごとにまとめ（切れ目＝スライドの切り替わりにするため）、
 * 長いスライドはさらに分ける。1スライドが複数セグメントになってもよいように
 * media_segments は idx と slide_idx を別に持っている。
 */
export function groupIntoSegments(
  lines: ScriptLine[],
  slideCount: number,
): { slide: number; lines: ScriptLine[] }[] {
  const groups: { slide: number; lines: ScriptLine[] }[] = [];

  for (let slide = 0; slide < slideCount; slide++) {
    const own = lines.filter((l) => l.slide === slide);
    if (own.length === 0) continue;

    let chunk: ScriptLine[] = [];
    let chars = 0;

    for (const line of own) {
      // 1発話が上限を超えていても、発話の途中では切らない
      // （文の途中で音声が切れると聞き取れなくなる）。
      if (chunk.length > 0 && chars + line.text.length > MAX_SEGMENT_CHARS) {
        groups.push({ slide, lines: chunk });
        chunk = [];
        chars = 0;
      }
      chunk.push(line);
      chars += line.text.length;
    }

    if (chunk.length > 0) groups.push({ slide, lines: chunk });
  }

  return groups;
}

/** 音声化のもとになる記事。ダイジェストなら含まれる記事すべて。 */
async function loadSource(
  db: SupabaseClient,
  media: { kind: string; article_id: string | null; digest_id: string | null; title: string },
) {
  let ids: string[] = [];

  if (media.kind === 'article' && media.article_id) {
    ids = [media.article_id];
  } else if (media.digest_id) {
    const { data: digest } = await db
      .from('digests')
      .select('article_ids')
      .eq('id', media.digest_id)
      .single();
    ids = (digest?.article_ids ?? []) as string[];
  }

  if (ids.length === 0) throw new Error('音声化する記事がありません');

  const { data } = await db
    .from('articles')
    .select('id, title, url, content_text, image_url, summaries (bullets)')
    .in('id', ids);

  const rows = (data ?? []) as unknown as {
    id: string;
    title: string;
    url: string;
    content_text: string | null;
    image_url: string | null;
    summaries: { bullets: string[] } | null;
  }[];

  // 渡した順（＝ダイジェストの選抜順）で話させる。
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return {
    title: media.title,
    articles: rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      bullets: r.summaries?.bullets ?? [],
      imageUrl: r.image_url,
      text: r.content_text ?? '',
    })),
  };
}

/**
 * 台本づくりの設定。
 *
 * 言い回しは NotebookLM 用の指示文を流用する（同じ好みが効くはずなので）。
 * 言語は要約と同じものを使う。ここを分けると、要約は英語で音声は日本語という
 * ちぐはぐが起きる（実際、台本側は日本語が直書きになっていた）。
 */
async function scriptSettings(
  db: SupabaseClient,
  userId: string,
): Promise<{ extra: string; language: string }> {
  const { data } = await db
    .from('settings')
    .select('notebooklm_prompt, summary_language')
    .eq('user_id', userId)
    .maybeSingle();

  return {
    extra: (data?.notebooklm_prompt ?? '').trim(),
    language: normalizeLanguage(data?.summary_language),
  };
}

export type { Slide };

/**
 * 表紙に使う画像のURLを決める。
 *
 * まず記事に控えてある image_url を見る（取り込みか本文抽出のときに付く）。
 * 0025 より前からある記事には付いていないので、そのときだけ**この場で**
 * og:image を読みに行き、次からのために記事側へ書き戻す。
 *
 * 全記事を後から浚う形にしないのは、実データで2024件が未設定だったため。
 * 表紙が要るのは音声にする1本だけなので、要るときに1件だけ取りに行く。
 * 先頭から数件しか試さないのは、絵が無いフィード（テキストのみのブログ等）で
 * 何十件も外部へ当てにいかないため。
 */
async function resolveCoverUrl(
  db: SupabaseClient,
  articles: { id: string; url: string; imageUrl: string | null }[],
): Promise<string | null> {
  const known = articles.find((a) => a.imageUrl)?.imageUrl;
  if (known) return known;

  for (const article of articles.slice(0, COVER_LOOKUPS)) {
    const found = await fetchImageUrl(article.url);
    if (!found) continue;
    // 書き戻しは失敗しても構わない（次回もう一度取りに行くだけ）。
    await db.from('articles').update({ image_url: found }).eq('id', article.id);
    return found;
  }

  return null;
}


/** AbortSignal.timeout() で打ち切られたか。名前でしか見分けられない。 */
function isAborted(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'TimeoutError') ||
    (err instanceof Error && /abort|timeout/i.test(err.name))
  );
}