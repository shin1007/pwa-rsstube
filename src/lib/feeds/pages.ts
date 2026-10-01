/**
 * 記事が複数ページに割れているとき、2ページ目以降のURLを見つける。
 *
 * WordPress の `<!--nextpage-->`（`wp_link_pages`）は、続きを `/記事/2` `/記事/3` に置き、
 * 各ページへのリンクに `post-page-numbers` を付ける。1ページ目だけ読むと
 * **前半しか取れていないのに、長さはあるので抽出は成功に見える**（nazology）。
 *
 * 追うのは「この記事自身のページ送り」だけ。同じホストで、1ページ目のURLの
 * 下にあるものに限る——関連記事や別の記事の一覧は追わない。
 */

/** 続きとして読むページ数の上限。無限に連なるページ送りでワーカーを使い切らない。 */
export const MAX_EXTRA_PAGES = 8;

type MinimalAnchor = { getAttribute(name: string): string | null };

type MinimalDocument = {
  querySelectorAll(selector: string): Iterable<MinimalAnchor>;
};

export function pickPageLinks(document: MinimalDocument, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const basePath = base.pathname.replace(/\/+$/, '');

  const found = new Map<number, string>();
  for (const a of document.querySelectorAll('a.post-page-numbers[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.host !== base.host) continue;
    const m = url.pathname.replace(/\/+$/, '').match(/^(.*)\/(\d{1,3})$/);
    // 1ページ目のURLの直下の `/N` だけ。2ページ目から見た `/archives/1/3` も同じ形。
    if (!m || m[1] !== basePath) continue;
    const n = Number(m[2]);
    if (n >= 2) found.set(n, url.href);
  }

  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_EXTRA_PAGES)
    .map(([, href]) => href);
}
