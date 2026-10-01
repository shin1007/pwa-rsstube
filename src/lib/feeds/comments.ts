import { parseHTML } from 'linkedom';

/**
 * 2ちゃんねるまとめ系のコメントを読みやすくする。
 *
 * まとめサイトの本文は、コメントが
 *   <p>2: 名前 2026/09/30(水) 12:43:30.65 ID:xxxx</p><p>コメント本文</p>
 * と、ヘッダー行（番号・名前・日時・ID）と本文が同じ見た目の段落で並ぶ。
 * 日時の行が本文と同じ大きさで挟まるので、どこからが発言か読み取れない。
 *
 * ヘッダーを小さく薄くし、本文と一組の枠に包む。**描画時に通す**ので、
 * 保存済みの記事にもそのまま効く（消毒は保存時なので、直しても既存の行に届かない）。
 * サイト名は見ない。「番号: 名前 日時」の形をしていれば他のまとめサイトにも当たる。
 */

// 番号（: か ： か空白で区切る）・名前・日時。日時は 2026/09/30 か 2026-09-30 の形。
const HEADER = /^\s*(\d{1,5})\s*[:：.．]?\s*([\s\S]*?)\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}[\s\S]*?)\s*$/;

/** ヘッダー行は短い。長い段落が偶然当たらないようにする。 */
const MAX_HEADER_CHARS = 200;

export function formatComments(html: string): string {
  // 日時の書式が無ければ対象外。パースを避けて素通しにする。
  if (!/\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(html)) return html;

  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const body = document.body;
  if (!body) return html;

  let changed = false;
  for (const p of Array.from(body.querySelectorAll('p'))) {
    const text = (p.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_HEADER_CHARS) continue;
    const m = HEADER.exec(text);
    if (!m) continue;
    // 入れ子の p（ヘッダーの中に本文がある）は対象外。
    if (p.querySelector('p')) continue;

    const next = p.nextElementSibling;
    const tag = next?.tagName?.toUpperCase();
    if (!next || (tag !== 'P' && tag !== 'DIV')) continue;
    if ((next.textContent ?? '').trim() === '') continue;

    const [, no, name, date] = m;
    const wrap = document.createElement('div');
    wrap.setAttribute('class', 'comment');
    const head = document.createElement('p');
    head.setAttribute('class', 'comment-head');
    for (const [cls, value] of [
      ['comment-no', no],
      ['comment-name', name.replace(/^名前\s*[:：]\s*/, '').replace(/[:：]\s*$/, '').trim()],
      ['comment-date', date],
    ] as const) {
      if (!value) continue;
      const span = document.createElement('span');
      span.setAttribute('class', cls);
      span.textContent = value;
      head.appendChild(span);
    }
    next.setAttribute('class', 'comment-body');
    p.replaceWith(wrap);
    wrap.appendChild(head);
    wrap.appendChild(next);
    changed = true;
  }

  return changed ? body.innerHTML : html;
}
