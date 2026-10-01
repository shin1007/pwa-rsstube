import { BATCH_SIZE, summarizeBatch, type SummaryInput } from '@/lib/ai/summarize';
import { SUMMARY_MODEL } from '@/lib/ai/gemini';
import { summaryKeysFor, type KeyHolder } from '@/lib/ai/keys';
import { recordUsage } from '@/lib/ai/usage';
import { contentHash, usableAsFallback } from '@/lib/feeds/content';
import { classifyError, retryAt, shouldRetry, type ExtractFailure } from '@/lib/feeds/retry';
import { normalizeLanguage } from '@/lib/language';
import { sanitizeHtml } from '@/lib/feeds/sanitize';
import { extractArticle, htmlToText } from '@/lib/feeds/extract';
import { claim, complete, enqueue, fail, release, type Job } from '@/lib/jobs/queue';
import { failAbandonedMedia, runScriptJob, runTtsJob, TTS_PER_RUN } from '@/lib/media/jobs';
import { authorizeCron, createAdminClient, ownerUserId } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ジョブワーカー。pg_cron から5分毎に叩かれる。
 *
 * 1回の実行で処理する量を絞ってあるので、記事が大量に入っても
 * Gemini の無料枠のレート制限に一度に当たらない。処理しきれなかったぶんは
 * 次の実行に持ち越される。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 本文取得は外部サイト次第で時間がかかる。長めに取る。
export const maxDuration = 60;

/** 1回の実行あたりの上限。extract は外部fetch、summarize は無料枠が律速。 */
const EXTRACT_PER_RUN = 12;
const SUMMARIZE_BATCHES_PER_RUN = 2;
/** 台本は1本作るだけで数千トークン出るので、1回の実行につき1本まで。 */
const SCRIPT_PER_RUN = 1;

/**
 * 1回の実行に使ってよい時間。
 *
 * 件数だけで絞っても、1件あたりの時間は相手次第で読めない（TTS は1セグメントに
 * 数十秒かかることがある）。maxDuration=60 を超えると関数ごと落とされ、
 * 途中の running のジョブが宙に浮く（0004 の回収待ちになる）。
 * 残り時間を見ながら、次の種類に進む前に切り上げる。
 */
const TIME_BUDGET_MS = 45_000;

/**
 * 外部呼び出しを打ち切る線。maxDuration(60秒)より手前に置く。
 *
 * 予算を見るのは**仕事と仕事の間だけ**なので、1回の呼び出しが長引くと
 * そのまま maxDuration を超えて関数ごと落とされる
 * （FUNCTION_INVOCATION_TIMEOUT。実際に起きた）。落とされると complete も
 * fail も呼べず、running のジョブが15分の拾い直し待ちになる。
 * 打ち切って自分で片付けるほうが、はるかに速く次へ進む。
 */
const HARD_LIMIT_MS = 52_000;

/**
 * 合成を1件始めるのに要る残り時間。
 *
 * 実測で1件20〜40秒かかる。残りわずかで始めても打ち切られるだけなので、
 * 足りないなら手を付けずに次の巡回へ回す。
 */
const MIN_TTS_SLICE_MS = 20_000;

export async function POST(request: Request) {
  if (!authorizeCron(request)) {
    return new Response('unauthorized', { status: 401 });
  }

  const db = createAdminClient();
  const deadline = Date.now() + TIME_BUDGET_MS;
  const hardDeadline = Date.now() + HARD_LIMIT_MS;

  const extracted = await runExtractJobs(db, deadline);
  const summarized = await runSummarizeJobs(db, deadline);
  // 音声は要約より後。要約が付いていない記事から台本を作っても薄くなる。
  const scripted = await runScriptJobs(db, deadline);
  const synthesized = await runTtsJobs(db, deadline, hardDeadline);

  /**
   * 誰も動かさなくなった音声を落とす。
   *
   * **時間予算の外で必ず通す。** ここを予算の中に置くと、忙しい日ほど
   * 飛ばされて、詰まった音声が「合成中」のまま何日も残る（それが元の壊れ方）。
   * SQL を1回叩くだけなので、予算を気にする重さではない。
   * 最後に置くのは、この実行で諦めたぶんを次の巡回まで待たずに拾うため。
   */
  const abandoned = await failAbandonedMedia(db);

  return Response.json({
    extracted,
    summarized,
    scripted,
    synthesized,
    abandoned,
    // 予算を使い切ったなら、残りは次の実行に持ち越されている。
    outOfTime: Date.now() >= deadline,
  });
}

export const GET = POST;

/** 本文抽出。取れなければ RSS の内容にフォールバックし、いずれにせよ要約へ進める。 */
async function runExtractJobs(db: SupabaseClient, deadline: number): Promise<number> {
  const jobs = await claim(db, EXTRACT_PER_RUN, 'extract');
  let done = 0;
  let i = 0;

  for (; i < jobs.length; i++) {
    // 引いたぶんを全部やり切る必要はない。手を付けなかったぶんは下で戻す。
    if (Date.now() >= deadline) break;
    const job = jobs[i];
    const articleId = job.payload.article_id as string | undefined;
    if (!articleId) {
      await complete(db, job.id);
      continue;
    }

    try {
      const { data: article } = await db
        .from('articles')
        .select('id, url, feed_id, rss_html, excerpt, extract_attempts')
        .eq('id', articleId)
        .single();

      if (!article) {
        await complete(db, job.id);
        continue;
      }

      /**
       * RSS の中身で妥協する。抽出が失敗したときと、掴んだものが記事で
       * なかったとき（使い回しページ）の両方から呼ぶ。
       *
       * 使えないときは**何も返さない**。「Comments」のような、本文の代わりに
       * ならない説明文を保存すると、一覧にも要約にもそれが並ぶ。
       */
      const fromRss = (): { text: string; html: string } | null => {
        // **content_text を見てはいけない。** あの列は抽出結果で上書きされるので、
        // 取り直しのときに読むと前回掴んだゴミが返ってくる（東洋経済で実際に
        // メニュー1244字を「RSSの内容」として拾い直していた）。
        // 0021 で足した rss_html が上書きされない控え。古い記事にはまだ無いので、
        // そのときは excerpt を使う（東洋経済の場合はここに実要約が入っている）。
        for (const source of [article.rss_html, article.excerpt]) {
          if (!source) continue;
          const t = htmlToText(source);
          if (!usableAsFallback(t)) continue;
          // RSS の中身も第三者が書いたものなので、描画に回すぶんは必ず消毒する。
          return { text: t, html: sanitizeHtml(source, article.url) };
        }
        return null;
      };

      // 何回目か。取り直しの上限に使う（0028）。
      const attempts = (article.extract_attempts ?? 0) + 1;

      let text = '';
      let html = '';
      let ok = false;
      let imageUrl: string | null = null;
      // 取れなかったときの理由。あとで取り直すかどうかをこれで決める（0028）。
      let failure: ExtractFailure | null = null;
      try {
        const result = await extractArticle(article.url);
        text = result.text;
        html = result.html;
        ok = result.ok;
        imageUrl = result.imageUrl;
        if (!ok) failure = 'short';
      } catch (e) {
        // 403やタイムアウトは珍しくない。ここで即座に再試行しても大抵また失敗するので、
        // RSSの内容で妥協して先へ進め、**理由に見込みがあるものだけ後で取り直す**。
        failure = classifyError(e);
      }

      // 同じフィードで本文が丸ごと一致したら、記事ではなく使い回しのページ
      // （エラーページ・同意画面・グローバルメニュー）とみなす。
      let hash: string | null = null;
      if (ok) {
        hash = contentHash(text);
        if (hash && (await isRecycledPage(db, article.feed_id, articleId, hash))) {
          ok = false;
          // 掴んだのがメニューや同意画面なら、相手の作りがそのままである限り
          // 何度取り直しても同じものが返る。取り直しの対象から外す。
          failure = 'recycled';
        }
      }

      if (!ok) {
        // **ここが抜けていた。** 使い回しと判定したあとに落とし直していなかったので、
        // 掴んだメニューがそのまま content_text に残っていた（東洋経済で実際に
        // 「有料会員登録 お知らせ ビジネス…」が1244字ぶん保存されていた）。
        // 判定したなら中身も捨てること。
        const rss = fromRss();
        text = rss?.text ?? '';
        html = rss?.html ?? '';
      }

      /**
       * **戻り値を必ず見ること。**
       *
       * ここだけエラーを捨てていた。書き込みが失敗しても要約へ進んで
       * ジョブを完了扱いにするので、記事は `extracted_at` が null のまま
       * 誰も拾い直さない。画面には永久に「順番待ち」と出続ける
       * （実データで17件がこの状態だった。要約は付いているのに未抽出扱い）。
       * 投げておけば catch が fail_job に回し、あとで再試行される。
       */
      const { error: updateError } = await db
        .from('articles')
        .update({
          // 使えるものが無ければ空にする。ゴミを残すくらいなら
          // 「取れなかった」と分かるほうがよい（一覧には excerpt が出る）。
          content_text: text || null,
          // 描画用。抽出に失敗しても RSS 本文から作れていれば残す。
          content_html: html || null,
          content_ok: ok,
          // 使い回しと判定したものはハッシュを残さない。残すと、次の記事が
          // それと一致して連鎖的に落ちる（判定の基準が壊れたページになる）。
          content_hash: ok ? hash : null,
          // og:image が取れたときだけ上書きする。取れなかったときに null で
          // 潰すと、取り込みのときに RSS の enclosure から拾った絵まで消える
          // （本文が 403 のサイトは、フィード側の絵だけが頼りになる）。
          ...(imageUrl ? { image_url: imageUrl } : {}),
          // 取りに行ったことを残す。これが無いと、失敗したのか順番待ちなのかが
          // 後から区別できない（0014）。
          extracted_at: new Date().toISOString(),
          // なぜ取れなかったか（0028）。成功したら消す——取り直しで取れた記事に
          // 古い理由が残ると、あとで数えたときに失敗として数えてしまう。
          extract_fail: failure,
          extract_attempts: attempts,
        })
        .eq('id', articleId);
      if (updateError) throw updateError;

      /**
       * 要約を積むのは、初回か、取り直して**実際に本文が取れたとき**だけ。
       *
       * 取り直しでも駄目だったものまで積むと、同じ RSS 抜粋から同じ要約を
       * もう一度作ることになり、無料枠を1回ぶん捨てる。
       */
      // **中身が1文字も無いなら要約しない。** タイトルしか無い記事に要約を
      // 頼むと、モデルは「本文や具体的な情報は存在しない」という*入力の説明*を
      // 返してくる。それが一覧に並ぶうえ、無料枠も1件ぶん使う。
      // 実データで43件（漫画の各話・審議会の資料ページなど）がこれだった。
      if (text.trim() && (attempts === 1 || ok)) {
        await enqueue(db, 'summarize', { article_id: articleId });
      }

      await complete(db, job.id);

      /**
       * 見込みのあるものだけ、後でもう一度取りに行く（`lib/feeds/retry.ts`）。
       *
       * **complete() より後に積むこと。** `jobs_pending_unique_idx` は
       * ('queued','running') を対象にしているので、このジョブが running の間は
       * 同じ (extract, article_id) が 23505 で黙って捨てられる。
       */
      if (failure && shouldRetry(failure, attempts)) {
        await enqueue(db, 'extract', { article_id: articleId }, undefined, retryAt());
      }

      done++;
    } catch (err) {
      await fail(db, job.id, err);
    }
  }

  await release(db, jobs.slice(i).map((j) => j.id));
  return done;
}

/** 要約。複数記事を1リクエストにまとめて無料枠を節約する。 */
async function runSummarizeJobs(db: SupabaseClient, deadline: number): Promise<number> {
  // 要約は全ユーザー共通なので（0005）、言語も1つしか選べない。
  // 当面はオーナーの設定をその1つとして使う。購読者ごとに言語を変えたくなったら、
  // summaries を (article_id, language) で持つ形にする必要がある。
  const { data: settings } = await db
    .from('settings')
    .select('summary_language')
    .eq('user_id', ownerUserId())
    .maybeSingle();
  const language = normalizeLanguage(settings?.summary_language);

  let done = 0;

  for (let i = 0; i < SUMMARIZE_BATCHES_PER_RUN; i++) {
    if (Date.now() >= deadline) break;
    const jobs = await claim(db, BATCH_SIZE, 'summarize');
    if (jobs.length === 0) break;

    const byArticle = new Map<string, Job>();
    for (const job of jobs) {
      const id = job.payload.article_id as string | undefined;
      if (id) byArticle.set(id, job);
      else await complete(db, job.id);
    }
    if (byArticle.size === 0) continue;

    const { data: articles } = await db
      .from('articles')
      .select('id, feed_id, title, content_text, content_ok')
      .in('id', [...byArticle.keys()]);

    /**
     * 誰の鍵で要約するか（0046・lib/ai/keys.ts）。記事は共通なので、
     * フィードの購読者のうちの誰か1人の鍵で1回作れば全員に付く。
     */
    const keys = await summaryKeysFor(db, [
      ...new Set((articles ?? []).map((a) => a.feed_id as string)),
    ]);

    /**
     * 中身が空の記事はモデルに渡さない。
     *
     * 積む側でも弾いているが、手で積み直したぶんや、以前のコードで積まれた
     * ぶんがここに来る。渡すと「本文や具体的な情報は存在しない」という
     * 入力の説明が返ってきて、それが要約として保存される。
     * ジョブは完了扱いにする——待たせても中身が増えることはない。
     */
    const groups = new Map<string, { holder: KeyHolder; inputs: SummaryInput[] }>();
    const skipped: string[] = [];
    for (const a of articles ?? []) {
      const text = (a.content_text ?? '').trim();
      if (!text) {
        const job = byArticle.get(a.id);
        if (job) {
          await complete(db, job.id);
          byArticle.delete(a.id);
        }
        continue;
      }
      const holder = keys.get(a.feed_id);
      if (!holder) {
        skipped.push(a.id);
        continue;
      }
      const group = groups.get(holder.userId) ?? { holder, inputs: [] };
      group.inputs.push({ id: a.id, title: a.title, text, contentOk: a.content_ok });
      groups.set(holder.userId, group);
    }

    /**
     * 鍵を持つ購読者が1人もいない記事は、要約を見送る。
     *
     * **印を付けること。** 0045 で「要約が付くまで一覧に出さない」にしたので、
     * 印が無いとこの記事は永久に一覧に出ない（待っても付かない）。
     * あとで誰かが鍵を入れたら、「要約なし」ビューから積み直せる。
     */
    if (skipped.length > 0) {
      const { error } = await db
        .from('articles')
        .update({ summary_skipped_at: new Date().toISOString() })
        .in('id', skipped);
      if (error) throw error;
      for (const id of skipped) {
        const job = byArticle.get(id);
        if (job) await complete(db, job.id);
        byArticle.delete(id);
      }
    }

    let limited = false;
    for (const { holder, inputs } of groups.values()) {
      const groupJobs = new Map(
        inputs.map((a) => [a.id, byArticle.get(a.id)!] as const).filter(([, j]) => j),
      );
      try {
        const { results, model, usage } = await summarizeBatch(holder.apiKey, inputs, language);
        await recordUsage(db, holder.userId, model, usage.inputTokens, usage.outputTokens, true);

        if (results.length > 0) {
          const { error } = await db.from('summaries').upsert(
            results.map((r) => ({
              article_id: r.id,
              // 空で返ってきたら列を埋めない。空文字を入れると「訳した結果が空」と
              // 区別できず、画面側で原題に戻す判断ができなくなる。
              title_ja: r.title_ja?.trim() || null,
              bullets: r.bullets,
              tags: r.tags,
              model,
            })),
            { onConflict: 'article_id' },
          );
          if (error) throw error;
        }

        // 返ってきたぶんは完了。
        const returned = new Set(results.map((r) => r.id));
        for (const [articleId, job] of groupJobs) {
          if (returned.has(articleId)) await complete(db, job.id);
        }

        /**
         * 返らなかった記事は**1回だけ**やり直させる。
         *
         * モデルは5件のうち1件を落とすことがある。以前はここで完了扱いにしていたので、
         * 落ちた記事には二度と要約が付かなかった（実データで5件が取り残されていた）。
         * かといって無制限に再試行すると無料枠を食い潰す。
         *
         * `fail_job` の max_attempts に 2 を渡し、2回目で諦めさせる。次の回では
         * 別の記事と組み合わさるので、同じ落ち方をする確率は低い。
         * 諦めたものは「要約なし」ビューに残り、手で積み直せる。
         */
        for (const [articleId, job] of groupJobs) {
          if (returned.has(articleId)) continue;
          const { error } = await db.rpc('fail_job', {
            job_id: job.id,
            err: 'モデルがこの記事を返しませんでした',
            max_attempts: 2,
          });
          if (error) throw error;
        }

        done += results.length;
      } catch (err) {
        // 失敗した呼び出しも RPD を1回ぶん食う（429 で弾かれた場合は特に、
        // 「もう上限に当たっている」ことが数字に出ていないと原因を追えない）。
        await recordUsage(db, holder.userId, SUMMARY_MODEL, 0, 0, false);

        // RetryableError（429など）はバックオフして次回に回る。
        for (const job of groupJobs.values()) await fail(db, job.id, err);
        // レート制限に当たっているなら、この実行では以降も失敗する見込みが高い。
        // 鍵は人ごとに違うので、この回の残りの組は試す。
        limited = true;
      }
    }
    if (limited) break;
  }

  return done;
}

/** 台本作り。1本ぶんで数千トークン出るので、1回の実行につき1本だけ進める。 */
async function runScriptJobs(db: SupabaseClient, deadline: number): Promise<number> {
  if (Date.now() >= deadline) return 0;
  const jobs = await claim(db, SCRIPT_PER_RUN, 'script');
  let done = 0;
  for (const job of jobs) {
    if (await runScriptJob(db, job)) done++;
  }
  return done;
}

/**
 * 音声合成。スライド1枚ぶんが1回。
 *
 * 1本の番組が10前後のセグメントになるので、1回の実行で4つずつ進めると
 * 3回ほどの実行（15分ほど）で1本仕上がる。朝までに間に合えばよいので、
 * 無料枠を一度に食わないほうを取る。
 */
async function runTtsJobs(
  db: SupabaseClient,
  deadline: number,
  hardDeadline: number,
): Promise<number> {
  if (Date.now() >= deadline) return 0;
  const jobs = await claim(db, TTS_PER_RUN, 'tts');
  let done = 0;
  let i = 0;
  for (; i < jobs.length; i++) {
    // 1セグメントに数十秒かかる。**残りわずかなら始めない。**
    // 始めても打ち切られるだけで、そのぶん次の巡回が遅れる。
    if (deadline - Date.now() < MIN_TTS_SLICE_MS) break;
    if (await runTtsJob(db, jobs[i], hardDeadline)) done++;
  }
  // **手を付けなかったぶんは必ず戻す。**引いた時点で running になっているので、
  // 放っておくと15分の拾い直し待ちになり、そのぶん丸ごと止まる（0026）。
  await release(db, jobs.slice(i).map((j) => j.id));
  return done;
}

/**
 * 同じ本文が、同じフィードの別の記事で既に使われていないか。
 *
 * 使い回しのページ（エラーページ・同意画面）はどのURLでも同じものを返すので、
 * ここで一致する。本物の記事どうしが完全一致することは原理的に無いため、
 * 誤検出は起きない。
 *
 * 見つかったときは**先に保存されていたほうも取り消す**。1件目は比べる相手が
 * まだ無かっただけで、同じ使い回しのページを本文として持っている。
 */
async function isRecycledPage(
  db: SupabaseClient,
  feedId: string,
  articleId: string,
  hash: string,
): Promise<boolean> {
  const { data: same } = await db
    .from('articles')
    .select('id')
    .eq('feed_id', feedId)
    .eq('content_hash', hash)
    .neq('id', articleId)
    .limit(1);

  if (!same?.length) return false;

  // 取り消す対象を先に控える。update のあとでは content_hash が消えて引けない。
  const { data: peers } = await db
    .from('articles')
    .select('id')
    .eq('feed_id', feedId)
    .eq('content_hash', hash);

  await db
    .from('articles')
    .update({
      content_ok: false,
      content_hash: null,
      // **本文も一緒に捨てる。** 印だけ外して中身を残すと、掴んでしまった
      // メニューが本文として画面に出続ける（東洋経済で実際にそうなっていた）。
      content_text: null,
      content_html: null,
    })
    .eq('feed_id', feedId)
    .eq('content_hash', hash);

  // 消しっぱなしにせず、取り直させる。RSS の中身に落とし直せば
  // 「メニューしか無い」より読めるものが残る。
  for (const peer of peers ?? []) {
    if (peer.id !== articleId) await enqueue(db, 'extract', { article_id: peer.id });
  }

  return true;
}
