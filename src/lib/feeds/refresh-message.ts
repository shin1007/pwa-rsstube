import { oneSummary } from '@/lib/summaries';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 「引っぱって更新」の結果の文面。
 *
 * **巡回の数字をそのまま見せないこと。** 2つの理由で、一覧と食い違う:
 *
 * - 巡回は全員の購読を回す（`feeds_to_poll`）。`pollFeeds` の `newArticles` には
 *   **他人のフィードの新着**も入っている。
 * - 新着は要約が付くまで一覧に出ない（0047。鍵を入れている人・取り込んで24時間以内）。
 *   取り込んだ直後は**必ず**要約待ちなので、「新しい記事が3件」と出た直後の一覧には
 *   1件も増えていない。もう一度押すと、もう取り込み済みなので「新着はありません」。
 *   押した人には「3件来たと言ったのに消えた」としか見えない（実際に踏んだ）。
 *
 * なので「自分の一覧に入る件数」と「そのうち要約待ちで、まだ出ていない件数」を
 * 自分のクライアント（RLS で自分の記事・自分の言語の要約だけが見える）で数え直す。
 */

export type MyArrivals = {
  /** この更新で入った、自分が購読しているフィードの記事。 */
  fresh: number;
  /** そのうち要約待ちで、まだ一覧に出ていないもの。 */
  freshWaiting: number;
  /** 要約待ちで一覧に出ていないもの全部（前回以前に入ったぶんも含む）。 */
  waiting: number;
};

/** 0047 の「要約待ちは隠す」の窓。list_articles と同じ値にすること。 */
const HIDE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param supabase ログイン中のクライアント
 * @param since    この更新を始めた時刻。これ以降に入った記事を「この更新の新着」とする
 */
export async function countMyArrivals(supabase: SupabaseClient, since: Date): Promise<MyArrivals> {
  const [{ data: usesAi }, { data, error }] = await Promise.all([
    supabase.rpc('i_use_ai'),
    supabase
      .from('articles')
      .select('id, created_at, summaries (article_id), article_states!inner (user_id)')
      .gte('created_at', new Date(Date.now() - HIDE_WINDOW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);
  if (error) throw error;

  const rows = (data ?? []) as unknown as { created_at: string; summaries: unknown }[];
  const fresh = rows.filter((r) => new Date(r.created_at).getTime() >= since.getTime());
  // 鍵を入れていなければ隠されない（待っても付くとは限らないので、0047）。
  const hidden = (r: { summaries: unknown }) =>
    usesAi === true && !oneSummary(r.summaries as { article_id: string }[] | null);

  return {
    fresh: fresh.length,
    freshWaiting: fresh.filter(hidden).length,
    waiting: rows.filter(hidden).length,
  };
}

/**
 * @param base 新着が無かったときの文面（「新着はありません」「さっき取りに行ったばかりです」など）
 */
export function refreshMessage(a: MyArrivals, base: string): string {
  if (a.fresh > 0) {
    if (a.freshWaiting === 0) return `新しい記事が${a.fresh}件`;
    if (a.freshWaiting === a.fresh) {
      return `新しい記事が${a.fresh}件。要約ができしだい一覧に出ます（数分）`;
    }
    return `新しい記事が${a.fresh}件（うち${a.freshWaiting}件は要約ができしだい出ます）`;
  }
  if (a.waiting > 0) return `${base}。要約待ちが${a.waiting}件あり、できしだい一覧に出ます`;
  return base;
}
