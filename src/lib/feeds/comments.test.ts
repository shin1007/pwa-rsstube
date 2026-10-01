import { describe, expect, it } from 'vitest';
import { formatComments } from './comments';

describe('formatComments', () => {
  it('ヘッダーと本文を1組の枠に包む', () => {
    const out = formatComments(
      '<p>2: <span>ジャガー(庭) [ﾆﾀﾞ]</span> <span> 2026/09/30(水) 12:43:30.65 ID:xWDx0</span></p><p> 来なくていい </p>',
    );
    expect(out).toContain('class="comment"');
    expect(out).toContain('<span class="comment-no">2</span>');
    expect(out).toContain('ジャガー(庭) [ﾆﾀﾞ]');
    expect(out).toContain('2026/09/30(水) 12:43:30.65 ID:xWDx0');
    expect(out).toContain('class="comment-body"');
  });

  it('日時の無い段落や長い段落は触らない', () => {
    const html = '<p>1: ふつうの段落です</p><p>本文</p>';
    expect(formatComments(html)).toBe(html);
    const long = `<p>3: ${'あ'.repeat(300)} 2026/09/30</p><p>x</p>`;
    expect(formatComments(long)).toBe(long);
  });
});
