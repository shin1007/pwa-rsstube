import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { pickPageLinks } from '@/lib/feeds/pages';

const doc = (body: string) => parseHTML(`<!DOCTYPE html><html><body>${body}</body></html>`).document;

describe('pickPageLinks', () => {
  const url = 'https://example.com/archives/10';

  it('2ページ目以降を番号順に、重複なしで返す', () => {
    const d = doc(`
      <a class="post-page-numbers" href="https://example.com/archives/10/3">3</a>
      <a class="post-page-numbers" href="/archives/10/2">2</a>
      <a class="post-page-numbers" href="/archives/10/2">次へ</a>`);
    expect(pickPageLinks(d, url)).toEqual([
      'https://example.com/archives/10/2',
      'https://example.com/archives/10/3',
    ]);
  });

  it('別ホスト・別記事のページ送りは追わない', () => {
    const d = doc(`
      <a class="post-page-numbers" href="https://other.example/archives/10/2">x</a>
      <a class="post-page-numbers" href="/archives/11/2">y</a>`);
    expect(pickPageLinks(d, url)).toEqual([]);
  });

  it('ページ送りが無ければ空', () => {
    expect(pickPageLinks(doc('<a href="/archives/10/2">2</a>'), url)).toEqual([]);
  });
});
