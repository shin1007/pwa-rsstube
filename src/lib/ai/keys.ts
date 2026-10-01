import { geminiClient } from './gemini';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 誰の Gemini API キーで呼ぶか（0046）。
 *
 * 鍵はユーザーごと。2人目以降は設定画面で自分の鍵を入れ、その人の無料枠で動く。
 * オーナーだけは環境変数 `GEMINI_API_KEY` に落ちる（設定画面で入れればそちらが優先）。
 *
 * **オーナー以外を環境変数に落とさないこと。** 落とすと、鍵を入れていない人の
 * 要約や音声がオーナーの無料枠で黙って動き、`gemini-3.5-flash` の1日20回が
 * 他人の音声1本で尽きる。
 *
 * ここで渡す `db` は必ず Secret キーのクライアント。ai_keys には RLS の
 * ポリシーが1つも無い（ログイン中のセッションからは読めない）。
 */

export type KeyHolder = { userId: string; apiKey: string };

function ownerId(): string | null {
  return process.env.OWNER_USER_ID || null;
}

/** 保存済みの鍵が無いときに使う鍵。オーナーにだけある。 */
function fallbackKey(userId: string): string | null {
  return userId === ownerId() ? process.env.GEMINI_API_KEY || null : null;
}

/** その人の鍵。無ければ null（＝その人のための AI 処理はしない）。 */
export async function geminiKeyFor(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from('ai_keys')
    .select('gemini_api_key')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.gemini_api_key || fallbackKey(userId);
}

/**
 * 要約に使う鍵を、フィードごとに決める。
 *
 * 要約は全員共通（0005）なので、記事1件につき誰か1人の鍵で1回作れば足りる。
 * 選び方:
 *   1. オーナーが購読していればオーナー。もともとオーナーの枠で作っていたもので、
 *      2人目が同じフィードを購読しても、その人の枠を減らさない
 *   2. いなければ、鍵を持つ購読者のうち先に購読した人。同じ人に寄るので、
 *      1日の使用量が読みやすい
 *
 * 誰も鍵を持っていないフィードは Map に入らない（＝要約を見送る）。
 */
export async function summaryKeysFor(
  db: SupabaseClient,
  feedIds: string[],
): Promise<Map<string, KeyHolder>> {
  const out = new Map<string, KeyHolder>();
  if (feedIds.length === 0) return out;

  const { data: subs, error } = await db
    .from('subscriptions')
    .select('user_id, feed_id, created_at')
    .in('feed_id', feedIds)
    .order('created_at');
  if (error) throw error;
  if (!subs?.length) return out;

  const userIds = [...new Set(subs.map((s) => s.user_id as string))];
  const { data: keys, error: keyError } = await db
    .from('ai_keys')
    .select('user_id, gemini_api_key')
    .in('user_id', userIds);
  if (keyError) throw keyError;

  const stored = new Map((keys ?? []).map((k) => [k.user_id as string, k.gemini_api_key as string]));
  const keyOf = (userId: string) => stored.get(userId) || fallbackKey(userId);
  const owner = ownerId();

  for (const feedId of feedIds) {
    const subscribers = subs.filter((s) => s.feed_id === feedId).map((s) => s.user_id as string);
    const ordered = owner && subscribers.includes(owner)
      ? [owner, ...subscribers.filter((u) => u !== owner)]
      : subscribers;
    for (const userId of ordered) {
      const apiKey = keyOf(userId);
      if (apiKey) {
        out.set(feedId, { userId, apiKey });
        break;
      }
    }
  }
  return out;
}

/** 画面に出すための伏せ字。末尾4文字だけ見せる（どの鍵を入れたか見分けるため）。 */
export function maskKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

/**
 * 押した人が AI を使えるか。要約・音声を受け付ける前に見る。
 *
 * 受け付けてから鍵が無いと分かると、ジョブは積まれたまま何も起きず、
 * 押した人には理由が届かない。押した瞬間に言う。
 *
 * **'use server' のファイルに置かないこと。** そこから export すると、
 * 誰でも任意の userId を渡して叩ける入口になる。
 */
export async function canUseAi(userId: string): Promise<boolean> {
  // オーナーは環境変数があれば動く。毎回 DB を引かずに済ませる。
  if (fallbackKey(userId)) return true;
  return Boolean(await geminiKeyFor(createAdminClient(), userId));
}

/** 鍵がまだ無いときに出す一文。押した操作の結果として返す。 */
export const MISSING_KEY_MESSAGE =
  'AI を使うには、設定画面で Gemini の API キーを入れてください';

/**
 * 鍵が本物か、保存する前に確かめる。
 *
 * モデルの情報を1回引くだけ（生成はしないので無料枠の回数は減らない）。
 * 確かめずに保存すると、間違った鍵は夜中のワーカーで初めて 400 になり、
 * 要約が付かない理由が画面のどこにも出ない。
 */
export async function verifyGeminiKey(apiKey: string, model: string): Promise<string | null> {
  try {
    await geminiClient(apiKey).models.get({ model });
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/API[_ ]?key|\b(400|401|403)\b|PERMISSION_DENIED|INVALID_ARGUMENT/i.test(message)) {
      return 'この API キーでは Gemini を呼べませんでした。Google AI Studio で発行した鍵か確かめてください';
    }
    return `鍵を確かめられませんでした（${message.slice(0, 200)}）。少し待ってからもう一度お試しください`;
  }
}
