import { describe, expect, it } from 'vitest';
import { refreshMessage } from './refresh-message';

describe('refreshMessage', () => {
  const base = '新着はありません';

  it('新着がすぐ一覧に出るなら件数だけ', () => {
    expect(refreshMessage({ fresh: 3, freshWaiting: 0, waiting: 0 }, base)).toBe('新しい記事が3件');
  });

  it('新着が全部要約待ちなら、まだ出ていないことを言う', () => {
    expect(refreshMessage({ fresh: 3, freshWaiting: 3, waiting: 3 }, base)).toBe(
      '新しい記事が3件。要約ができしだい一覧に出ます（数分）',
    );
  });

  it('一部だけ要約待ちなら、その件数を添える', () => {
    expect(refreshMessage({ fresh: 3, freshWaiting: 1, waiting: 1 }, base)).toBe(
      '新しい記事が3件（うち1件は要約ができしだい出ます）',
    );
  });

  it('新着が無くても、前に入った要約待ちがあれば言う（2回目に押したとき）', () => {
    expect(refreshMessage({ fresh: 0, freshWaiting: 0, waiting: 3 }, base)).toBe(
      '新着はありません。要約待ちが3件あり、できしだい一覧に出ます',
    );
  });

  it('何も無ければ元の文面のまま', () => {
    expect(refreshMessage({ fresh: 0, freshWaiting: 0, waiting: 0 }, base)).toBe(base);
  });
});
