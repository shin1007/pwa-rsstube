import { beforeEach, describe, expect, it } from 'vitest';
import { recordVisit, rememberHeads, resetTrail, trailSnapshot } from './trail';

describe('trail', () => {
  beforeEach(resetTrail);

  it('「前」で進んだ記事は手前に差し込む（B で ← → A、A の前が B に戻らない）', () => {
    recordVisit('k', 'B');
    rememberHeads('B', 'A', 'C');
    recordVisit('k', 'A');
    expect(trailSnapshot().ids).toEqual(['A', 'B']);
    expect(trailSnapshot().pos).toBe(0);
  });

  it('「次」で進んだ記事は後ろに足す', () => {
    recordVisit('k', 'B');
    rememberHeads('B', 'A', 'C');
    recordVisit('k', 'C');
    expect(trailSnapshot().ids).toEqual(['B', 'C']);
    expect(trailSnapshot().pos).toBe(1);
  });

  it('一覧から押して開いた記事は従来どおり後ろに足す', () => {
    recordVisit('k', 'B');
    rememberHeads('B', 'A', 'C');
    recordVisit('k', 'Z');
    expect(trailSnapshot().ids).toEqual(['B', 'Z']);
  });
});
