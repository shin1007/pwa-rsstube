'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * 読み進めた順を、その場（このタブ・この絞り込み）だけで覚えておく。
 *
 * **未読ビューで「前の記事」に戻れないのを直すためのもの。** 前後の行き先は
 * サーバーが一覧から出しているが（app/page.tsx）、未読ビューでは開いた記事が
 * その場で既読になって一覧から抜ける。つまり**さっき読んだ記事は、次の描画の
 * 一覧にはもう1件も残っていない**。
 *
 * その状態で「前」を出そうとすると、日付の近い**別の未読**が出てくる。
 * 実測では → を12回押してから ← を押すと、来た道ではない記事へ飛び、
 * 3回目で行き先が尽きて止まった（＝戻れない）。
 *
 * サーバー側では直せない。「いま読んだばかりの記事も一覧に残す」は、
 * 未読の定義を変えることになるし、どこまでを「さっき」とするかも決められない。
 * 実際に開いた順を覚えているのはブラウザだけなので、ここで持つ。
 *
 * 覚えるのは id の並びだけ。**リロードで消えてよい**——消えたらサーバーが出す
 * 一覧の順に戻るだけで、いまと同じ動きになる。
 *
 * 絞り込み（ビュー・フォルダ・検索）が変わったら捨てる。別の一覧を見ているのに
 * 前の一覧の順で動くと、押した先が画面のどこにも無い記事になる。
 */

type Trail = {
  /**
   * どの絞り込みの並びか。変わったら捨てる。
   *
   * **まだ何も記録していない状態は `null`。空文字にしないこと。**
   * 絞り込みが何も無い一覧（＝未読ビューをそのまま開いた状態）のキーは
   * 空文字なので、初期値を空文字にすると「同じ並びを見ている」と一致してしまい、
   * 下の `at === state.pos` に -1 === -1 で引っかかって**1件も記録されない**。
   * 未読ビューだけ来た道が空のままになり、「次」で進んだあと「前」が
   * 押せないままだった（フォルダや検索で開いたときは、キーが空でないので
   * 初回に上の分岐で作り直され、正しく動いていた）。
   */
  key: string | null;
  ids: readonly string[];
  /** いま何番目を見ているか。-1 は空。 */
  pos: number;
};

const EMPTY: Trail = { key: null, ids: [], pos: -1 };

/**
 * 記事ごとに「サーバーが出した前／次」を覚えておく。**向きを知るため。**
 *
 * 来た道は開いた順だが、知らない記事へ「前」で進んだときまで**後ろに足すと**、
 * その記事の「前」が来た道（＝さっきの記事）になって、2件のあいだを行き来し続ける。
 * 例: B で ← を押すとサーバーの前は A。`[B, A]` と記録すると、A で ← を押したとき
 * 来た道が B を指す。B で ← → A、A で ← → B …と永久に着かない。
 * スターを外した記事は一覧から抜けるので、特に踏みやすい。
 */
const serverHeads = new Map<string, { prev?: string; next?: string }>();

function articleIdOf(href?: string) {
  if (!href) return undefined;
  return new URL(href, 'http://local').searchParams.get('article') ?? undefined;
}

let state: Trail = EMPTY;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot() {
  return state;
}

/**
 * サーバーでは常に空。ここで `state` を返すと、描き出した HTML と
 * 最初の描画が食い違う（この記憶はタブごとのものなので、サーバーには無い）。
 */
function serverSnapshot() {
  return EMPTY;
}

/**
 * 訪れた記事を記録する。
 *
 * 既に並びの中にある記事なら、位置を動かすだけ（戻ったとき）。
 * 知らない記事なら、いまの位置の**後ろを捨ててから**足す——ブラウザの履歴と
 * 同じ考え方。3つ戻ってから一覧の別の記事を開いたのに、「次」が
 * さっきまでの続きを指したままだと、押した先が話の流れと合わない。
 */
export function recordVisit(key: string, id: string) {
  if (state.key !== key) {
    state = { key, ids: [id], pos: 0 };
    notify();
    return;
  }
  const at = state.ids.indexOf(id);
  if (at === state.pos) return;
  if (at >= 0) {
    state = { ...state, pos: at };
  } else if (isServerPrev(state.ids[state.pos], id)) {
    // 「前」へ進んだ。手前に差し込む（pos は新しい記事を指したまま）。
    state = { key, ids: [...state.ids.slice(0, state.pos), id, ...state.ids.slice(state.pos)], pos: state.pos };
  } else {
    state = { key, ids: [...state.ids.slice(0, state.pos + 1), id], pos: state.pos + 1 };
  }
  notify();
}

function isServerPrev(from: string | undefined, id: string) {
  const heads = from ? serverHeads.get(from) : undefined;
  return !!heads && heads.prev === id && heads.next !== id;
}

/** テスト用。いまの並びを返す。 */
export function trailSnapshot() {
  return state;
}

/** テスト用。覚えを捨てる。 */
export function resetTrail() {
  state = EMPTY;
  serverHeads.clear();
}

/** テスト用。サーバーが出した前後を覚えさせる。 */
export function rememberHeads(id: string, prev?: string, next?: string) {
  serverHeads.set(id, { prev, next });
}

/** 記事を除いた検索文字列。これが「同じ一覧を見ている」の判定になる。 */
function filterKey(searchParams: URLSearchParams | ReadonlyURLSearchParams) {
  const sp = new URLSearchParams(searchParams.toString());
  sp.delete('article');
  return sp.toString();
}

type ReadonlyURLSearchParams = ReturnType<typeof useSearchParams>;

/** いま開いている記事を記録する。本文が出ている画面から1回だけ呼ぶこと。 */
export function useRecordVisit(articleId?: string) {
  const searchParams = useSearchParams();
  const key = filterKey(searchParams);
  useEffect(() => {
    if (articleId) recordVisit(key, articleId);
  }, [key, articleId]);
}

/**
 * 前後の行き先。**来た道があればそちらを優先する。**
 *
 * 来た道が無い側（まだ進んでいない先）はサーバーが出したものをそのまま使う。
 * つまり「進む」はいつもどおり一覧の続きで、「戻る」だけが来た道になる。
 */
export function useNeighbours(
  articleId: string | undefined,
  prevHref?: string,
  nextHref?: string,
) {
  const searchParams = useSearchParams();
  const key = filterKey(searchParams);
  const trail = useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  useEffect(() => {
    if (!articleId) return;
    serverHeads.set(articleId, { prev: articleIdOf(prevHref), next: articleIdOf(nextHref) });
  }, [articleId, prevHref, nextHref]);

  if (!articleId || trail.key !== key) return { prevHref, nextHref };

  const at = trail.ids.indexOf(articleId);
  if (at < 0) return { prevHref, nextHref };

  const to = (id: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('article', id);
    return `/?${sp.toString()}`;
  };

  return {
    prevHref: at > 0 ? to(trail.ids[at - 1]) : prevHref,
    nextHref: at < trail.ids.length - 1 ? to(trail.ids[at + 1]) : nextHref,
  };
}
