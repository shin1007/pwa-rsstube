import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { summaryKeysFor } from './keys';

const OWNER = 'owner';

type Sub = { user_id: string; feed_id: string; created_at: string };

/** subscriptions / ai_keys / settings だけを返す、問い合わせの形を真似た偽物。 */
function fakeDb(
  subs: Sub[],
  keys: { user_id: string; gemini_api_key: string }[],
  settings: { user_id: string; summary_language: string }[] = [],
): SupabaseClient {
  const from = (table: string) => ({
    select: () => ({
      in: (_col: string, values: string[]) => {
        if (table === 'subscriptions') {
          const rows = subs
            .filter((s) => values.includes(s.feed_id))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          return { order: async () => ({ data: rows, error: null }) };
        }
        const rows = (table === 'ai_keys' ? keys : settings) as { user_id: string }[];
        return Promise.resolve({ data: rows.filter((r) => values.includes(r.user_id)), error: null });
      },
    }),
  });
  return { from } as unknown as SupabaseClient;
}

describe('summaryKeysFor', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.OWNER_USER_ID = OWNER;
    process.env.GEMINI_API_KEY = 'env-key';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('オーナーが購読していれば、後から購読した人が鍵を持っていてもオーナーの鍵', async () => {
    const db = fakeDb(
      [
        { user_id: 'alice', feed_id: 'f1', created_at: '2026-01-01' },
        { user_id: OWNER, feed_id: 'f1', created_at: '2026-02-01' },
      ],
      [{ user_id: 'alice', gemini_api_key: 'alice-key' }],
    );
    const keys = await summaryKeysFor(db, ['f1']);
    expect(keys.get('f1')?.get('ja')).toEqual({ userId: OWNER, apiKey: 'env-key' });
  });

  it('オーナーが鍵を保存していれば、環境変数より優先する', async () => {
    const db = fakeDb(
      [{ user_id: OWNER, feed_id: 'f1', created_at: '2026-01-01' }],
      [{ user_id: OWNER, gemini_api_key: 'owner-stored' }],
    );
    const keys = await summaryKeysFor(db, ['f1']);
    expect(keys.get('f1')?.get('ja')?.apiKey).toBe('owner-stored');
  });

  it('オーナー以外は環境変数に落ちない（鍵を持つ購読者のうち先に購読した人）', async () => {
    const db = fakeDb(
      [
        { user_id: 'bob', feed_id: 'f2', created_at: '2026-01-01' },
        { user_id: 'carol', feed_id: 'f2', created_at: '2026-01-02' },
        { user_id: 'dave', feed_id: 'f2', created_at: '2026-01-03' },
      ],
      [
        { user_id: 'carol', gemini_api_key: 'carol-key' },
        { user_id: 'dave', gemini_api_key: 'dave-key' },
      ],
    );
    const keys = await summaryKeysFor(db, ['f2']);
    expect(keys.get('f2')?.get('ja')).toEqual({ userId: 'carol', apiKey: 'carol-key' });
  });

  it('言語ごとに、その言語で読む人の鍵を使う（他の言語の人の枠は使わない）', async () => {
    const db = fakeDb(
      [
        { user_id: OWNER, feed_id: 'f4', created_at: '2026-01-01' },
        { user_id: 'erin', feed_id: 'f4', created_at: '2026-01-02' },
        { user_id: 'frank', feed_id: 'f4', created_at: '2026-01-03' },
      ],
      [{ user_id: 'erin', gemini_api_key: 'erin-key' }],
      [
        { user_id: 'erin', summary_language: 'en' },
        { user_id: 'frank', summary_language: 'ko' },
      ],
    );
    const keys = await summaryKeysFor(db, ['f4']);
    expect(keys.get('f4')?.get('ja')?.userId).toBe(OWNER);
    expect(keys.get('f4')?.get('en')).toEqual({ userId: 'erin', apiKey: 'erin-key' });
    // 韓国語で読む人は鍵を持っていない。オーナーや erin の枠では作らない。
    expect(keys.get('f4')?.has('ko')).toBe(false);
  });

  it('誰も鍵を持っていなければ入らない（要約を作らない）', async () => {
    const db = fakeDb([{ user_id: 'bob', feed_id: 'f3', created_at: '2026-01-01' }], []);
    const keys = await summaryKeysFor(db, ['f3']);
    expect(keys.has('f3')).toBe(false);
  });
});
