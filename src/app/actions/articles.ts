'use server';

import { canUseAi, MISSING_KEY_MESSAGE } from '@/lib/ai/keys';
import { attempt } from '@/lib/actions/result';
import { currentUser } from '@/lib/auth/session';
import { listArticles } from '@/lib/articles';
import { PAGE_SIZE, type ArticleRow, type View } from '@/lib/types';

import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/**
 * 記事の状態変更。
 *
 * Server Function は UI を経由せず直接 POST できてしまうので、
 * どの関数でも必ずログイン確認をしてから書き込む。
 * 実データの保護は RLS（user_id = auth.uid()）が担保している。
 */

/**
 * ログアウト。自分専用とはいえ、端末を貸すときに抜ける手段は要る。
 *
 * **`supabase.auth.signOut()` だけに任せてはいけない。**
 * GoTrueClient は、セッションを読む段階で「セッションが無い」以外のエラーが出ると
 * **Cookie を消さずにエラーを返して戻る**（refresh token が既に使われていた、
 * Supabase に届かなかった、など）。こちらがその戻り値を見ずに `/login` へ飛ばすと、
 * Cookie が生きたままなので proxy の「ログイン済みで /login なら / へ」に引っかかり、
 * **押しても元の画面に戻るだけ**になる。出口が無くなるので、Cookie は自分で消す。
 */
export async function signOut() {
  const supabase = await createClient();

  // 他の端末のセッションも切りたいので既定（global）のまま。ただし
  // 失敗してもここで止まらない。抜けられないほうが困る。
  try {
    await supabase.auth.signOut();
  } catch {
    // 通信できなくても、下で Cookie を消せばこの端末からは抜けられる。
  }

  // 消し残しが1つでもあると proxy に「ログイン済み」と見なされる。
  // 分割された Cookie（`.0` `.1`）も一緒に消すこと。セッションが大きいと
  // @supabase/ssr が勝手に分割するので、本体だけ消しても残る。
  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (/^sb-.+-auth-token(\.\d+)?$/.test(cookie.name)) cookieStore.delete(cookie.name);
  }

  redirect('/login');
}

async function client() {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) throw new Error('未ログインです');
  return { supabase, userId: user.id };
}

/**
 * `revalidate` を切れるようにしてあるのは**速さのため**。
 *
 * `revalidatePath('/')` を呼ぶと、Next はこの Server Action の応答に
 * **`/` をまるごと描き直した RSC を積んで返す**（呼ばなければ描き直さない。
 * `next/dist/server/app-render/action-handler.js` の `skipPageRendering` が
 * 「revalidate したかどうか」だけを見ている）。`/` の RSC は実測89KB——
 * ほぼ全部が変わっていないサイドバーと一覧1ページぶんで、サーバー側では Supabase に
 * 6往復する。**記事を1本開くたびに、遷移そのものと同じ重さの描き直しが
 * もう1回走っていた。**
 *
 * なので**押した結果が画面で分かる操作**（スター・手で付けた既読）は
 * 今までどおり revalidate し、**開いた拍子に付く既読**だけ黙って書く。
 * 既読の見た目は ArticleList の楽観更新が持つ。サイドバーの未読数だけは
 * 次の描画まで1件ぶん古いままになるが、読み終える前に減るほうが嘘に近い。
 */
async function setState(
  articleId: string,
  patch: Record<string, unknown>,
  { revalidate = true }: { revalidate?: boolean } = {},
): Promise<void> {
  const { supabase, userId } = await client();
  const { error } = await supabase
    .from('article_states')
    .upsert(
      { article_id: articleId, user_id: userId, ...patch, updated_at: new Date().toISOString() },
      // 主キーは (article_id, user_id)。0005 で記事を全ユーザー共通にしたときに
      // こう変わった。article_id だけを指定すると、それに合う一意制約が無いので
      // Postgres が 42P10 で弾き、既読もスターも**全部失敗する**。
      { onConflict: 'article_id,user_id' },
    );
  if (error) throw error;
  if (revalidate) revalidatePath('/');
}

/**
 * 既読・未読。
 *
 * `quiet` は「記事を開いたので既読にする」ときだけ立てる。ページの描き直しを
 * 抱き合わせないぶん、遷移が1往復まるごと軽くなる（setState のコメント）。
 * **手で押した既読・未読は quiet にしない**——一覧から消える／戻ることが
 * 押した結果なので、そこは描き直してよい。
 */
export async function markRead(articleId: string, read = true, quiet = false) {
  await setState(
    articleId,
    { is_read: read, read_at: read ? new Date().toISOString() : null },
    { revalidate: !quiet },
  );
}

export async function setStarred(articleId: string, starred: boolean) {
  await setState(articleId, { is_starred: starred });
}


/**
 * 表示中の記事をまとめて既読／未読にする（Inoreader の "Mark all as read" 相当）。
 *
 * read=false を受けられるのは取り消しのため。1ページぶんがまとめて消える操作を
 * 戻せないままにしておくと、押し間違いの被害が大きい。
 */
export async function setReadMany(articleIds: string[], read = true) {
  if (articleIds.length === 0) return;
  const { supabase, userId } = await client();
  if (!(await canUseAi(userId))) throw new Error(MISSING_KEY_MESSAGE);

  const now = new Date().toISOString();
  const { error } = await supabase.from('article_states').upsert(
    articleIds.map((id) => ({
      article_id: id,
      user_id: userId,
      is_read: read,
      read_at: read ? now : null,
      updated_at: now,
    })),
    // setState と同じ理由で (article_id, user_id)。
    { onConflict: 'article_id,user_id' },
  );
  if (error) throw error;
  revalidatePath('/');
}

/**
 * 表示中の記事をまとめて要約し直す。「要約なし」ビューから使う。
 * 一気に積んでも、ワーカーが1回の実行で食べる量は絞ってあるので溢れない。
 */
export async function requestSummaries(articleIds: string[]) {
  return attempt(() => requestSummariesImpl(articleIds));
}

async function requestSummariesImpl(articleIds: string[]) {
  if (articleIds.length === 0) return;
  const { supabase, userId } = await client();
  if (!(await canUseAi(userId))) throw new Error(MISSING_KEY_MESSAGE);

  // 未処理ジョブがある記事は先に除く。jobs の一意索引は部分索引なので
  // upsert では回避できず、1件でもぶつかると insert 全体が落ちてしまう。
  const { data: pending, error: pendingError } = await supabase
    .from('jobs')
    .select('payload')
    .in('status', ['queued', 'running'])
    .in('payload->>article_id', articleIds);
  if (pendingError) throw pendingError;

  const queued = new Set(
    (pending ?? []).map((j) => (j.payload as { article_id?: string }).article_id),
  );
  const targets = articleIds.filter((id) => !queued.has(id));
  if (targets.length === 0) return;

  const { error } = await supabase.from('jobs').insert(
    targets.map((id) => ({ user_id: userId, type: 'extract', payload: { article_id: id } })),
  );
  if (error) throw error;
  revalidatePath('/');
}

const VIEWS: View[] = ['unread', 'starred', 'all', 'unsummarized'];

/** これ以上は遡らせない。無限スクロールに終わりが無いと、古い記事を延々と
 *  取りに行けてしまう（1回 PAGE_SIZE 件・往復ぶんの負荷がそのままかかる）。
 *  掘り返す用途は /library の検索が持っているので、一覧はここで打ち止めにする。 */
const MAX_OFFSET = 3000;

/**
 * 一覧の続きを取る（無限スクロール）。
 *
 * 絞り込みはクライアントから渡ってくるが、Server Function は UI を経由せず
 * 直接叩けるので view はここで通す値を決め直す。データそのものは RLS と
 * article_states!inner が絞るので、他人の記事は出ない。
 */
export async function loadMoreArticles(input: {
  view: string;
  folderId?: string;
  feedId?: string;
  search?: string;
  offset: number;
}) {
  return attempt(() => loadMoreArticlesImpl(input));
}

async function loadMoreArticlesImpl(input: {
  view: string;
  folderId?: string;
  feedId?: string;
  search?: string;
  offset: number;
}): Promise<{ articles: ArticleRow[]; done: boolean }> {
  await client();

  const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
  if (offset >= MAX_OFFSET) return { articles: [], done: true };

  // 総数は1ページ目でしか要らないので、ここでは受け取らない（listArticles が
  // offset を見て頼み分ける）。終わりは「返ってきた数が1ページに満たないこと」で見る。
  const { articles } = await listArticles({
    view: (VIEWS as string[]).includes(input.view) ? (input.view as View) : 'unread',
    folderId: input.folderId || undefined,
    feedId: input.feedId || undefined,
    search: input.search?.trim() || undefined,
    offset,
  });

  // 返ってきた数が1ページに満たなければ、そこが終わり。
  // 件数の総数を数えないのは、未読ビューだと読むそばから変わるため。
  return { articles, done: articles.length < PAGE_SIZE || offset + articles.length >= MAX_OFFSET };
}

/** 要約が無い記事、または要約をやり直したい記事をキューに積む。 */
export async function requestSummary(articleId: string) {
  return attempt(() => requestSummaryImpl(articleId));
}

async function requestSummaryImpl(articleId: string) {
  const { supabase, userId } = await client();
  // 鍵が無いまま積んでも、要約は見送られて何も起きない（0046）。押した時点で言う。
  if (!(await canUseAi(userId))) throw new Error(MISSING_KEY_MESSAGE);
  const { error } = await supabase
    .from('jobs')
    .insert({ user_id: userId, type: 'extract', payload: { article_id: articleId } });
  // 同じ記事の未処理ジョブが既にあるだけなので、重複エラーは無視してよい。
  if (error && error.code !== '23505') throw error;
  revalidatePath('/');
}
