import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Gemini の使用量。
 *
 * 無料枠には RPD（1日あたりのリクエスト数）の上限がある。フィードを増やせば
 * 要約の呼び出しも比例して増えるが、いま何回使っているかがアプリから見えないと、
 * 上限に当たって初めて気づくことになる（ジョブが 429 でバックオフし、
 * 要約が静かに遅れ続ける）。
 *
 * 記録は日×モデル×鍵の持ち主の集計（0009・0046）。呼び出しごとに行を作ると
 * 掃除が要るため。無料枠は鍵ごとに数えられるので、誰の鍵で呼んだかを分けて持つ。
 */

export type UsageDay = {
  day: string;
  model: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * 呼び出し1回ぶんを足し込む。
 *
 * 記録に失敗しても本処理は止めない。使用量が1回ぶん抜けることより、
 * 要約そのものが巻き戻るほうが困る。
 */
export async function recordUsage(
  db: SupabaseClient,
  /** 誰の鍵で呼んだか（lib/ai/keys.ts）。作らせた人ではなく、鍵の持ち主。 */
  userId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  ok: boolean,
): Promise<void> {
  const { error } = await db.rpc('record_ai_usage', {
    p_model: model,
    p_input: inputTokens,
    p_output: outputTokens,
    p_ok: ok,
    p_user: userId,
  });
  if (error) console.error('使用量の記録に失敗:', error.message);
}

/** 直近の使用量。設定画面に出す。自分の鍵のぶんだけ返る（RLS。0046）。 */
export async function recentUsage(days = 7): Promise<UsageDay[]> {
  const supabase = await createClient();

  // 日付の境目は記録側と同じ日本時間で切る（0009 の record_ai_usage を参照）。
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from('ai_usage')
    .select('day, model, calls, failures, input_tokens, output_tokens')
    .gte('day', since)
    .order('day', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((r) => ({
    day: r.day as string,
    model: r.model as string,
    calls: r.calls as number,
    failures: r.failures as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
  }));
}
