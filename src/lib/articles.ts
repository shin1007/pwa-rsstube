import { oneSummary } from '@/lib/summaries';
import { createClient } from '@/lib/supabase/server';
import { sanitizeSearch } from '@/lib/search';
import { PAGE_SIZE, asId, type ArticleRow, type View } from '@/lib/types';

/**
 * 一覧用の記事取得。**問い合わせは `list_articles()`（0042）に1本化してある。**
 *
 * 以前はここが直列2〜3往復だった——購読の feed_id を引く → 返ってきてから
 * 記事を引く →（記事を開いていて位置が出せなければ）前後の id をもう1往復。
 * 本番のデータで計ると **DB の仕事は合計 4.5ms しかない**（素の往復が
 * 34.3ms）ので、払っていたのは往復そのものだった。0039 で `shell_data()` が
 * 4本を1本にまとめたのと同じ形が、一覧に残っていた。
 *
 * 絞り込み・並び順・総数の数え方は**全部 SQL 側が持っている**。ここに
 * 条件を書き足さないこと——一覧と総数と前後の id で条件がずれると、
 * 「あと12件」と出しておきながら3件目で終わる形で表に出る。
 * 記事・要約・フィードは全ユーザー共通なので（0005）、「自分の記事」を
 * 切り出しているのは `article_states` の有無（RLS）。
 */

export type ArticleQuery = {
  view: View;
  folderId?: string;
  feedId?: string;
  search?: string;
  /**
   * 何件目から返すか。無限スクロールの継ぎ足しで使う。
   *
   * 未読ビューでは読んだ記事が一覧から抜けるので、**続きを取っている間に
   * 位置がずれる**（既読にしたぶんだけ後ろが繰り上がる）。ここでは直さない。
   * 受け取る側が id で重複を落とすこと。
   */
  offset?: number;
};

/**
 * 一覧1ページぶんと、いまの絞り込みの総数。
 *
 * **総数は一覧と同じ1回で返る**（SQL の `count(*) over ()`）。別に数えていた
 * 頃は、並べて投げても**その1本が毎回いちばん遅かった**（実測・一覧 79ms に
 * 対して件数だけの `head: true` が 112ms）。数える走査ではなく、PostgREST が
 * もう1本組み立てて往復するぶんを払っていたということ。
 *
 * 総数が要るのは1ページ目だけ（「あと何件」の表示）。継ぎ足しでは頼まない。
 */
export type ArticlePage = {
  articles: ArticleRow[];
  /** いまの絞り込みの総数。頼んでいないとき（継ぎ足し）は null。 */
  total: number | null;
};

/** SQL 側が返す形。行の形は ArticleRow に合わせてあるので、詰め替えは要らない。 */
type RawPage = { articles: ArticleRow[]; total: number | null };

/**
 * `list_articles()` を1回呼ぶ。**呼び口はここだけにすること。**
 * 引数の綴りを間違えても PostgREST は既定値で通してしまう（黙って
 * 「全部」の一覧が返る）ので、組み立てる場所を散らさない。
 */
async function run(query: ArticleQuery, limit: number, idsOnly: boolean, withCount: boolean) {
  const supabase = await createClient();

  // 語の下ごしらえだけはこちら。`&@` は問い合わせ構文を解釈しないので記号で
  // 壊れることは無いが、長さの上限（100字）はここで効かせておく。
  const term = query.search ? sanitizeSearch(query.search) : '';

  // **消毒して何も残らなかった語は「絞らない」ではなく「1件も当たらない」。**
  // 空の語をそのまま渡すと絞りが外れて全件出る（検索したのに、が起きる）。
  // ついでに、その1往復も要らない。
  if (query.search && !term) return { articles: [], total: withCount ? 0 : null };

  const { data, error } = await supabase.rpc('list_articles', {
    p_view: query.view,
    p_folder: query.folderId ?? null,
    p_feed: query.feedId ?? null,
    p_term: term || null,
    p_limit: limit,
    p_offset: query.offset ?? 0,
    p_with_count: withCount,
    p_ids_only: idsOnly,
  });

  if (error) throw error;

  const page = (data ?? {}) as Partial<RawPage>;
  return { articles: page.articles ?? [], total: page.total ?? null };
}

export async function listArticles(query: ArticleQuery): Promise<ArticlePage> {
  return run(query, PAGE_SIZE, false, (query.offset ?? 0) === 0);
}

/**
 * 前後の記事を出すための id 一覧。
 *
 * 無限スクロールで先へ進んでから開いた記事は1ページ目に入っていないので、
 * 一覧の配列からは位置が出せない。かといって記事を1ページぶんずつ何度も
 * 取り直すのは高い（本文も要約も付いてくる）。ここは id しか運ばない。
 *
 * 上限を切ってあるのは、一覧の無限スクロールと同じ理由。ここより深いところの
 * 前後は出ない（出せないぶんはリンクを出さない。押せないボタンは出さない）。
 */
const NEIGHBOUR_SCAN = 600;

/**
 * 日付も一緒に返すのは、**一覧に居ない記事の位置を出すため**。
 * 未読ビューで開いた記事はその場で既読になるので、次に一覧を引いたときには
 * もう居ない。id では引っかからないが、日付なら「居たはずの場所」が分かる。
 */
export type ArticleSlot = { id: string; published_at: string | null };

export async function listArticleIds(query: ArticleQuery): Promise<ArticleSlot[]> {
  const { articles } = await run({ ...query, offset: 0 }, NEIGHBOUR_SCAN, true, false);
  return articles as unknown as ArticleSlot[];
}

/**
 * 本文ペインに出す1本ぶん。
 *
 * **`article_states` は配列で返ってくる。** 主キーが `(article_id, user_id)` の
 * 複合なので、PostgREST は記事から見て「多」の関係だと判断する（RLS で
 * 自分の1行しか返らなくても、形は配列のまま）。受け取る側は
 * `state?.is_read` のように**物として**読んでいたので、**ずっと undefined**
 * だった——スター・書き出し済みの印が本文の上に出ず、「出したなら
 * 既読にする」も毎回「未読」から始めていた。型は `| null` と書いてあるので
 * 型検査では捕まらない。ここで物に均してから渡す。
 */
export async function getArticle(id: string) {
  // 形が違う id は「無い記事」と同じ扱い（lib/types.ts の asId を参照）。
  if (!asId(id)) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('articles')
    .select(
      `id, title, url, author, published_at, excerpt, content_text, content_html, content_ok, extracted_at, extract_fail, created_at,
       feeds (id, title),
       summaries (bullets, tags, title_ja),
       article_states (is_read, is_starred, exported_at)`,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const states = data.article_states as unknown;
  return {
    ...data,
    // 言語ごとに持つので配列で返る（0047）。RLS が自分の言語だけに絞っている。
    summaries: oneSummary(
      data.summaries as unknown as { bullets: string[]; tags: string[]; title_ja: string | null }[],
    ),
    article_states: (Array.isArray(states) ? (states[0] ?? null) : states) as
      | { is_read: boolean; is_starred: boolean; exported_at: string | null }
      | null,
  };
}

/**
 * サイドバーに出す未読件数。フィード単位で集計する（呼び出し側でフォルダにまとめる）。
 *
 * 数えるのは DB 側（0020 の `unread_counts()`）。以前は未読の記事を最大5000行
 * 取ってきて JS で数えていたが、実測で1171行が返っていた。欲しいのは18個の
 * 数字だけなので、その65倍を毎回運んでいたことになる。
 * しかもこれは全ページで呼ばれる（AppShell が持つため）ので、常時かかる。
 */
export async function unreadCounts(): Promise<Map<string, number>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('unread_counts');

  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { feed_id: string; unread: number }[]) {
    counts.set(row.feed_id, Number(row.unread));
  }
  return counts;
}
