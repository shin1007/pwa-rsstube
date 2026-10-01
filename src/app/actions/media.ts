'use server';

import { canUseAi, MISSING_KEY_MESSAGE } from '@/lib/ai/keys';
import { currentUser } from '@/lib/auth/session';
import { requestMedia, retryMedia, type MediaTarget, type RetryFrom } from '@/lib/media/create';
import { getPlayable, type MediaSource, type PlayableSegment } from '@/lib/media/list';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/**
 * 音声化の受付。
 *
 * 押した時点では何もできていない。ワーカーが台本 → 合成の順に少しずつ進めるので、
 * 戻り値は「どこで進み具合を見られるか」だけ返す。
 *
 * 失敗を throw で返さないのは、**本番では Server Action の例外が握り潰される**ため。
 * Next は投げられたエラーを digest に置き換えてしまうので、クライアントには
 * 「Minified React error #441」（＝中身を伏せた Server Components のエラー）しか
 * 届かず、'記事が見つかりません' のような文面は本番で一度も表に出ない。
 * 見せたい文面は値として返すこと。
 */

export type MediaRequestResult =
  | { ok: true; id: string; created: boolean; message: string }
  | { ok: false; message: string };

export async function requestArticleMedia(articleId: string): Promise<MediaRequestResult> {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) return { ok: false, message: '未ログインです' };

  const { data: article } = await supabase
    .from('articles')
    .select('title')
    .eq('id', articleId)
    .maybeSingle();
  if (!article) return { ok: false, message: '記事が見つかりません' };

  return run(supabase, user.id, { kind: 'article', articleId }, article.title);
}

export async function requestDigestMedia(digestId: string): Promise<MediaRequestResult> {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) return { ok: false, message: '未ログインです' };

  const { data: digest } = await supabase
    .from('digests')
    .select('date')
    .eq('id', digestId)
    .maybeSingle();
  if (!digest) return { ok: false, message: 'ダイジェストが見つかりません' };

  return run(supabase, user.id, { kind: 'digest', digestId }, `ダイジェスト ${digest.date}`);
}

async function run(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  target: MediaTarget,
  title: string,
): Promise<MediaRequestResult> {
  // 台本も音声も、作らせた本人の鍵で作る（0046）。無いなら受け付けない。
  if (!(await canUseAi(userId))) return { ok: false, message: MISSING_KEY_MESSAGE };

  let id: string;
  let created: boolean;
  let retried: boolean;
  try {
    ({ id, created, retried } = await requestMedia(supabase, userId, target, title));
  } catch (e) {
    // 中身はサーバーのログに残す。表に出すのは短い一文だけ。
    console.error('requestMedia failed', e);
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `音声化を受け付けられませんでした: ${detail}` };
  }

  revalidatePath('/listen');
  revalidatePath('/exports');

  return {
    ok: true,
    id,
    created,
    message: created
      ? '音声化をキューに入れました。数分後に「聴く」に出ます。'
      : retried
        ? '前回は途中で止まっていたので、続きから作り直します。'
        : '既に作ってあります。「聴く」から開けます。',
  };
}

/**
 * 諦めた音声を作り直す。
 *
 * 「聴く」の一覧から押す。**できているところは捨てない**ので、10 セグメント中
 * 8 つまで合成できていたなら残り2つだけをやり直す（lib/media/create.ts）。
 *
 * 持ち主かどうかはユーザーのクライアントで確かめる。media には RLS があるので、
 * 他人の id を渡すと単に見つからない扱いになる。
 */
export async function retryMediaAction(mediaId: string): Promise<MediaRequestResult> {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) return { ok: false, message: '未ログインです' };

  const { data: media } = await supabase
    .from('media')
    .select('id')
    .eq('id', mediaId)
    .maybeSingle();
  if (!media) return { ok: false, message: '音声が見つかりません' };
  if (!(await canUseAi(user.id))) return { ok: false, message: MISSING_KEY_MESSAGE };

  let from: RetryFrom;
  try {
    from = await retryMedia(mediaId);
  } catch (e) {
    console.error('retryMedia failed', e);
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `作り直しを受け付けられませんでした: ${detail}` };
  }

  revalidatePath('/listen');
  revalidatePath(`/watch/${mediaId}`);

  return {
    ok: true,
    id: mediaId,
    created: false,
    message:
      from === 'ready'
        ? '合成は全部できていました。そのまま聴けます。'
        : from === 'script'
          ? '台本から作り直します。数分後に「聴く」に出ます。'
          : '合成できていないところだけ作り直します。数分後に出ます。',
  };
}

/**
 * 一覧ページの下部プレイヤー用に、1本ぶんの再生材料を取り出す。
 *
 * 一覧が持っているのは要約だけで、音声のURLは無い（署名付きURLは有効期限が
 * あるので、一覧の全件ぶんを先に発行すると無駄が大きい）。押されたものだけ
 * その場で取りに行く。
 */
export type PlayableResult =
  | { ok: true; title: string; segments: PlayableSegment[]; sources: MediaSource[] }
  | { ok: false; message: string };

export async function loadPlayable(id: string): Promise<PlayableResult> {
  const media = await getPlayable(id);
  if (!media) return { ok: false, message: '音声が見つかりません' };
  if (media.segments.length === 0) {
    return { ok: false, message: 'まだ再生できる音声がありません' };
  }
  return { ok: true, title: media.title, segments: media.segments, sources: media.sources };
}

/**
 * 「聴いた」の印を付ける。**最初に鳴り始めた時点**で1回だけ呼ぶ（usePlayer）。
 *
 * 押したときではなく鳴ったときにするのは、素材の取得に失敗しても押しただけで
 * 未視聴が消えてしまわないようにするため。
 *
 * `is('played_at', null)` を付けて、二度目以降は行に触れない。「最初に聴いた時刻」を
 * 聴き直すたびに今へ動かすと、あとから「いつ聴いたか」で並べたくなったときに使えない。
 *
 * **revalidate しない。** ここはバッジの数を1つ減らすためだけの書き込みで、
 * 呼ばれるのは音が鳴り始めた瞬間——一覧を丸ごと描き直させると、聴き始めと同時に
 * ページの再構築が走る（`revalidatePath('/')` は描き直した RSC を応答に積む）。
 * バッジは次の画面遷移で追いつけばよい。
 */
export async function markMediaPlayed(mediaId: string): Promise<void> {
  const supabase = await createClient();

  await supabase
    .from('media')
    .update({ played_at: new Date().toISOString() })
    .eq('id', mediaId)
    .is('played_at', null);
}
