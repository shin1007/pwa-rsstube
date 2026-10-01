'use server';

import { geminiKeyFor, maskKey, verifyGeminiKey } from '@/lib/ai/keys';
import { SUMMARY_MODEL } from '@/lib/ai/gemini';
import { attempt } from '@/lib/actions/result';
import { currentUser } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/**
 * ユーザーごとの Gemini API キー（0046）。
 *
 * 読み書きは Secret キーのクライアントから。ai_keys には RLS のポリシーが
 * 1つも無いので、ログイン中のセッションでは触れない（意図してそうしてある）。
 * 鍵そのものは画面へ返さない——返すのは「入っているか」と末尾4文字だけ。
 */

async function me(): Promise<string> {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) throw new Error('未ログインです');
  return user.id;
}

export type GeminiKeyStatus = {
  /** 何かしらの鍵で動けるか（保存した鍵か、オーナーなら環境変数）。 */
  usable: boolean;
  /** 保存した鍵の伏せ字。保存していなければ undefined。 */
  masked?: string;
  /** 保存した鍵が無く、環境変数の鍵で動いている（オーナーだけ）。 */
  fromEnv: boolean;
};

export async function getGeminiKeyStatus(): Promise<GeminiKeyStatus> {
  const userId = await me();
  const db = createAdminClient();
  const { data, error } = await db
    .from('ai_keys')
    .select('gemini_api_key')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;

  if (data?.gemini_api_key) {
    return { usable: true, masked: maskKey(data.gemini_api_key), fromEnv: false };
  }
  const usable = Boolean(await geminiKeyFor(db, userId));
  return { usable, fromEnv: usable };
}

export async function saveGeminiKey(formData: FormData) {
  return attempt(() => saveGeminiKeyImpl(formData));
}

async function saveGeminiKeyImpl(formData: FormData) {
  const userId = await me();
  // 貼り付けで前後に空白や改行が付きがち。鍵の中に空白は無い。
  const apiKey = String(formData.get('gemini_api_key') ?? '').trim();
  if (!apiKey) throw new Error('API キーを入れてください');

  const problem = await verifyGeminiKey(apiKey, SUMMARY_MODEL);
  if (problem) throw new Error(problem);

  const db = createAdminClient();
  const { error } = await db.from('ai_keys').upsert(
    { user_id: userId, gemini_api_key: apiKey, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
  revalidatePath('/settings');
}

export async function deleteGeminiKey() {
  return attempt(() => deleteGeminiKeyImpl());
}

async function deleteGeminiKeyImpl() {
  const userId = await me();
  const db = createAdminClient();
  const { error } = await db.from('ai_keys').delete().eq('user_id', userId);
  if (error) throw error;
  revalidatePath('/settings');
}
