'use server';

import { attempt } from '@/lib/actions/result';
import { currentUser } from '@/lib/auth/session';

import { fetchFeed } from '@/lib/feeds/parse';
import { discoverFeeds, type FeedCandidate } from '@/lib/feeds/discover';
import { fanOutStates, ingestFeedItems } from '@/lib/feeds/ingest';
import { relocateFeedUrl } from '@/lib/feeds/relocate';
import { pollFeeds, type PollableFeed } from '@/lib/feeds/poll';
import { countMyArrivals, refreshMessage } from '@/lib/feeds/refresh-message';
import { looksLikeUrl, searchFeeds } from '@/lib/feeds/search';
import { parseOpml } from '@/lib/feeds/opml';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';

/** フィードとフォルダの管理。 */

async function client() {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) throw new Error('未ログインです');
  return { supabase, userId: user.id };
}

/** フォルダ名からIDを引く。無ければ作る。OPML取り込みで使う。 */
async function folderId(
  supabase: Awaited<ReturnType<typeof client>>['supabase'],
  userId: string,
  name: string | undefined,
): Promise<string | null> {
  if (!name) return null;
  const { data: existing } = await supabase
    .from('folders')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('folders')
    .insert({ user_id: userId, name })
    .select('id')
    .single();
  if (error) throw error;
  return created.id;
}

export async function createFolder(formData: FormData) {
  return attempt(() => createFolderImpl(formData));
}

async function createFolderImpl(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;

  const { supabase, userId } = await client();
  // 末尾に置く。既存が全部 0 でも 1 以上になるので順序は壊れない。
  const { data: last } = await supabase
    .from('folders')
    .select('sort_order')
    .eq('user_id', userId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase
    .from('folders')
    .insert({ user_id: userId, name, sort_order: (last?.sort_order ?? 0) + 1 });
  if (error && error.code !== '23505') throw error; // 同名は一意制約で弾かれる

  revalidatePath('/settings');
  revalidatePath('/');
}

export async function renameFolder(id: string, formData: FormData) {
  return attempt(() => renameFolderImpl(id, formData));
}

async function renameFolderImpl(id: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;

  const { supabase } = await client();
  const { error } = await supabase.from('folders').update({ name }).eq('id', id);
  if (error && error.code !== '23505') throw error;

  revalidatePath('/settings');
  revalidatePath('/');
}

/** フォルダだけ消す。中のフィードは feeds.folder_id が null になって未分類に残る。 */
export async function deleteFolder(id: string) {
  return attempt(() => deleteFolderImpl(id));
}

async function deleteFolderImpl(id: string) {
  const { supabase } = await client();
  const { error } = await supabase.from('folders').delete().eq('id', id);
  if (error) throw error;
  revalidatePath('/settings');
  revalidatePath('/');
}

/**
 * フォルダの並べ替え。
 * 既存データは sort_order が全部 0 のことがあるので、隣と値を交換するのではなく
 * 現在の表示順どおりに 0..n-1 を振り直してから入れ替える。
 */
export async function moveFolder(id: string, direction: 'up' | 'down') {
  return attempt(() => moveFolderImpl(id, direction));
}

async function moveFolderImpl(id: string, direction: 'up' | 'down') {
  const { supabase, userId } = await client();

  const { data: folders } = await supabase
    .from('folders')
    .select('id')
    .eq('user_id', userId)
    .order('sort_order')
    .order('name');

  const ordered = folders ?? [];
  const i = ordered.findIndex((f) => f.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ordered.length) return;

  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];

  for (const [index, folder] of ordered.entries()) {
    const { error } = await supabase
      .from('folders')
      .update({ sort_order: index })
      .eq('id', folder.id);
    if (error) throw error;
  }

  revalidatePath('/settings');
  revalidatePath('/');
}

/** フィードのフォルダを移す。空文字なら未分類に戻す。フォルダは購読ごとの持ち物。 */
export async function moveFeed(feedId: string, formData: FormData) {
  return attempt(() => moveFeedImpl(feedId, formData));
}

async function moveFeedImpl(feedId: string, formData: FormData) {
  const raw = String(formData.get('folder_id') ?? '').trim();

  const { supabase, userId } = await client();
  const { error } = await supabase
    .from('subscriptions')
    .update({ folder_id: raw || null })
    .eq('user_id', userId)
    .eq('feed_id', feedId);
  if (error) throw error;

  revalidatePath('/settings');
  revalidatePath('/');
}

/**
 * フィードを探す。URL でも名前でもよい。
 *
 * URL に見えるならそのサイトを見に行き、そうでなければ名前で検索する。
 * URL のつもりが見つからなかった場合も、最後に名前として検索し直す
 * （`gigazine.net` のように、ドメインがそのまま名前として通ることがある）。
 *
 * 画面はこれを呼んでから候補を出し、選ばせてから subscribeFeed に渡す。
 * 登録してから「違うフィードだった」と気づくより、先に見せたほうが早い。
 */
export async function findFeeds(input: string) {
  return attempt(() => findFeedsImpl(input));
}

async function findFeedsImpl(input: string): Promise<FeedCandidate[]> {
  await client(); // 未ログインなら弾く（任意のURLを叩かせる踏み台にしない）。

  if (!looksLikeUrl(input)) return searchFeeds(input);

  try {
    return await discoverFeeds(input);
  } catch (err) {
    // URL として辿れなかった。名前として拾えることがあるので最後に試す。
    const fallback = await searchFeeds(input).catch(() => []);
    if (fallback.length > 0) return fallback;
    throw err;
  }
}

export async function subscribeFeed(
  url: string,
  folder?: string,
) {
  return attempt(() => subscribeFeedImpl(url, folder));
}

async function subscribeFeedImpl(
  url: string,
  folder?: string,
): Promise<{ title: string; newArticles: number }> {
  const { supabase, userId } = await client();

  // 登録前に一度取得して、フィードとして読めることとタイトルを確認する。
  const result = await fetchFeed(url);
  if (result.status !== 'ok') throw new Error('フィードを読めませんでした');

  // feeds は共通テーブルで直接 insert できない。購読の入口は RPC だけ（0006）。
  const { data: feedId, error } = await supabase.rpc('subscribe_feed', {
    feed_url: url,
    feed_title: result.title,
    feed_site: result.siteUrl ?? null,
    in_folder: await folderId(supabase, userId, folder?.trim() || undefined),
  });
  if (error) throw error;

  // 記事もその場で入れる。次の巡回を待つと、登録した直後の画面が空のままで
  // 「登録できたのか分からない」状態が最大1時間続く。
  // 記事の書き込みは共通テーブルなので、RLS を迂回するクライアントで行う。
  let newArticles = 0;
  try {
    const admin = createAdminClient();
    const ingested = await ingestFeedItems(admin, feedId as string, result);
    newArticles = ingested.newArticles;

    await admin
      .from('feeds')
      .update({
        etag: result.etag ?? null,
        last_modified: result.lastModified ?? null,
        last_fetched_at: new Date().toISOString(),
        error_count: 0,
        last_error: null,
      })
      .eq('id', feedId as string);
  } catch {
    // 取り込みに失敗しても購読自体は済んでいる。次の巡回で埋まる。
  }

  revalidatePath('/settings');
  revalidatePath('/');

  return { title: result.title, newArticles };
}

/** 旧来のフォーム経由の登録。OPML の隣に残してある。 */
export async function addFeed(formData: FormData) {
  return attempt(() => addFeedImpl(formData));
}

async function addFeedImpl(formData: FormData) {
  const url = String(formData.get('url') ?? '').trim();
  const folder = String(formData.get('folder') ?? '').trim() || undefined;
  if (!url) return;

  await subscribeFeed(url, folder);
}

/**
 * 壊れたフィードの行き先を探し直す。
 *
 * 巡回は 301 を見て自動で移転先を覚えるが、それが効くのは**古いURLが
 * 301 を返してくれる場合だけ**。いきなり 404 になったり、ドメインごと
 * 変わったりすると追えない。そのときは元のサイトから探し直すしかない。
 *
 * 見つかったら feeds.url を差し替える。購読・フォルダ・既読はフィードの id に
 * 紐づいているので、そのまま引き継がれる（登録し直すと全部消える）。
 */
export async function relocateFeed(feedId: string) {
  return attempt(() => relocateFeedImpl(feedId));
}

async function relocateFeedImpl(feedId: string): Promise<{ url: string; title: string }> {
  const { supabase } = await client();

  const { data: feed } = await supabase
    .from('feeds')
    .select('id, url, site_url, title')
    .eq('id', feedId)
    .maybeSingle();
  if (!feed) throw new Error('フィードが見つかりません');

  // 探し方は巡回の自動付け替えと同じものを使う（lib/feeds/relocate.ts）。
  // 書き込みは共通テーブルなので RLS を迂回するクライアントで行う。
  const result = await relocateFeedUrl(createAdminClient(), feed);

  if (result.status === 'not-found') throw new Error('新しいフィードが見つかりませんでした');
  if (result.status === 'same') throw new Error('いまと同じURLしか見つかりませんでした');
  if (result.status === 'taken') throw new Error('その行き先は別のフィードとして登録済みです');

  revalidatePath('/settings');
  revalidatePath('/');

  return { url: result.url, title: result.title };
}

/** 購読をやめたときに何がどうなるか。押す前に見せるための数え上げ。 */
export type UnsubscribeImpact = {
  /** 一覧から消える件数（未読＋ただ読んだだけのもの）。 */
  dropped: number;
  /** 残る件数の内訳。 */
  starred: number;
  exported: number;
};

export async function feedImpact(feedId: string) {
  return attempt(() => feedImpactImpl(feedId));
}

async function feedImpactImpl(feedId: string): Promise<UnsubscribeImpact> {
  const { supabase, userId } = await client();

  const { data, error } = await supabase
    .from('article_states')
    .select('is_starred, exported_at, articles!inner (feed_id)')
    .eq('user_id', userId)
    .eq('articles.feed_id', feedId);
  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    is_starred: boolean;
    exported_at: string | null;
  }[];

  // 印が付いているものは購読をやめても残る（0012）。残るものを先に数え、
  // それ以外を「消えるもの」とする。
  const kept = rows.filter((r) => r.is_starred || r.exported_at);

  return {
    dropped: rows.length - kept.length,
    starred: rows.filter((r) => r.is_starred).length,
    exported: rows.filter((r) => r.exported_at).length,
  };
}

/**
 * 購読をやめる。
 *
 * 記事とフィードは他の購読者のものでもあるので消さない。自分の状態行のうち、
 * 印を付けていないものだけが消える（スター・書き出し済みは残る。0012）。
 */
export async function deleteFeed(feedId: string) {
  return attempt(() => deleteFeedImpl(feedId));
}

async function deleteFeedImpl(feedId: string) {
  const { supabase } = await client();
  const { error } = await supabase.rpc('unsubscribe_feed', { in_feed_id: feedId });
  if (error) throw error;
  revalidatePath('/settings');
  revalidatePath('/');
}

/**
 * 購読をやめたのを取り消す。
 *
 * フィード自体は残っているので（誰かが購読していれば、いなくても
 * 印つきの記事があれば掃除されない）、購読の行を作り直せば戻る。
 * ただし印の無かった記事の既読・未読は戻らない。そのことは画面に出す。
 */
export async function resubscribeFeed(feedId: string, folderId?: string | null) {
  return attempt(() => resubscribeFeedImpl(feedId, folderId));
}

async function resubscribeFeedImpl(feedId: string, folderId?: string | null) {
  const { supabase } = await client();

  const { data: feed } = await supabase.from('feeds').select('url, title, site_url').eq('id', feedId).maybeSingle();
  if (!feed) throw new Error('フィードが見つかりません（掃除で消えた可能性があります）');

  const { error } = await supabase.rpc('subscribe_feed', {
    feed_url: feed.url,
    feed_title: feed.title ?? '',
    feed_site: feed.site_url ?? null,
    in_folder: folderId ?? null,
  });
  if (error) throw error;

  // 未読の状態行は購読解除で消えているので、作り直す。
  // 記事の書き込みは共通テーブルなので RLS を迂回するクライアントで行う。
  try {
    const admin = createAdminClient();
    const { data: articles } = await admin
      .from('articles')
      .select('id')
      .eq('feed_id', feedId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(200);

    const ids = (articles ?? []).map((a) => a.id as string);
    if (ids.length > 0) await fanOutStates(admin, feedId, ids);
  } catch {
    // 戻せなくても購読自体は復活している。記事は次の巡回で埋まる。
  }

  revalidatePath('/settings');
  revalidatePath('/');
}

/**
 * OPML取り込み。
 * 取り込み時点ではフィードの中身を取りに行かない（数百件あると時間切れになる）。
 * タイトルと記事は、次の巡回で埋まる。
 */
export async function importOpml(formData: FormData) {
  return attempt(() => importOpmlImpl(formData));
}

async function importOpmlImpl(formData: FormData) {
  const file = formData.get('opml');
  if (!(file instanceof File) || file.size === 0) return;

  const { supabase, userId } = await client();
  const feeds = parseOpml(await file.text());

  // フォルダ名 → ID を先にまとめて解決する。
  const folderIds = new Map<string, string | null>();
  for (const name of new Set(feeds.map((f) => f.folder).filter(Boolean) as string[])) {
    folderIds.set(name, await folderId(supabase, userId, name));
  }

  // 1件ずつ RPC を呼ぶ。数百件でも1往復あたりは軽い挿入で済む。
  for (const f of feeds) {
    const { error } = await supabase.rpc('subscribe_feed', {
      feed_url: f.xmlUrl,
      feed_title: f.title,
      feed_site: f.htmlUrl ?? null,
      in_folder: f.folder ? (folderIds.get(f.folder) ?? null) : null,
    });
    if (error) throw error;
  }

  revalidatePath('/settings');
  revalidatePath('/');
}

/**
 * 画面から「いま取りに行く」（引っぱって更新）。
 *
 * 巡回は pg_cron が1時間毎に回しているので、**最悪59分ぶん古いものを見ている**。
 * 朝に開いて「まだ来ていない」ときに、待つしかないのが不便だった。
 *
 * 中身は cron と同じ `pollFeeds`。**同じ処理をもう一組書かないこと**——
 * 取り込みが分かれると「こちらから更新したときだけ本文抽出が積まれない」
 * ような差が生まれ、しかも気づけない。
 *
 * ジョブを積むのは Secret キーからでないと RLS に弾かれる（jobs にポリシーが
 * 1つも無い。docs/traps/jobs.md）。なので admin クライアントを使う。
 */
export async function refreshFeeds() {
  return attempt(() => refreshFeedsImpl());
}

/** 1回で取りに行く本数。Server Action の実行時間に収める。 */
const REFRESH_FEEDS = 8;
/** ここを過ぎたら残りは次の巡回に任せる。 */
const REFRESH_BUDGET_MS = 20_000;
/** これより新しく取ったばかりなら、何もしない（連打で相手を叩かないため）。 */
const REFRESH_COOLDOWN_MS = 2 * 60 * 1000;

async function refreshFeedsImpl(): Promise<string> {
  // ログインしていることだけ確かめる（巡回自体は全ユーザー共通の処理）。
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('ログインしてください');

  const db = createAdminClient();
  const { data: feeds, error } = await db.rpc('feeds_to_poll', { job_limit: REFRESH_FEEDS });
  if (error) throw new Error(`フィードを選べませんでした: ${error.message}`);

  const list = (feeds ?? []) as PollableFeed[];

  /**
   * **さっき取ったばかりなら何もしない。** `feeds_to_poll` は古い順に返すので、
   * その先頭が「ついさっき」なら、全部が新しいということ。押すたびに相手の
   * サーバーを叩きに行くのは、こちらの都合でしかない。
   */
  const oldest = list[0]?.last_fetched_at;
  if (oldest && Date.now() - new Date(oldest).getTime() < REFRESH_COOLDOWN_MS) {
    return refreshMessage(
      await countMyArrivals(supabase, new Date()),
      'さっき取りに行ったばかりです',
    );
  }

  // 1秒の余裕は Vercel と DB の時計のずれのぶん。
  const startedAt = new Date(Date.now() - 1000);
  const r = await pollFeeds(db, list, REFRESH_BUDGET_MS);
  revalidatePath('/');

  /**
   * **`r.newArticles` をそのまま見せないこと。** 他人のフィードの新着も入っていて、
   * 自分のぶんも要約が付くまで一覧に出ない。「3件」と出たのに一覧が増えず、
   * もう一度押すと「新着なし」になった（lib/feeds/refresh-message.ts）。
   */
  const base =
    r.polled === 0 ? '新しい記事はありませんでした' : `${r.polled}本を見ましたが、新着はありません`;
  return refreshMessage(await countMyArrivals(supabase, startedAt), base);
}
