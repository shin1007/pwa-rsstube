import { GoogleGenAI } from '@google/genai';

/**
 * Gemini クライアントの薄いラッパ。
 *
 * 無料枠で回す前提なので、レート制限(429)とサーバ側の一時エラー(5xx)を
 * ここで見分けられるようにしておく。恒久的な失敗はすぐ諦め、
 * 一時的な失敗はジョブキューに戻して後で再試行させる。
 */

/**
 * 鍵ごとのクライアント。鍵はユーザーごとに違う（0046・lib/ai/keys.ts）。
 *
 * **鍵は必ず呼び出し側から渡すこと。** ここで環境変数に落とすと、
 * 鍵を入れていないユーザーの処理がオーナーの無料枠で黙って動く。
 */
const clients = new Map<string, GoogleGenAI>();

export function geminiClient(apiKey: string): GoogleGenAI {
  if (!apiKey) throw new Error('Gemini の API キーがありません');
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

/** 後で再試行する価値がある失敗（レート制限・一時的なサーバエラー）。 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

function classify(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(429|500|502|503|504)\b/.test(message) || /RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(message)) {
    throw new RetryableError(message);
  }
  throw err instanceof Error ? err : new Error(message);
}

/** 1回の呼び出しで使ったトークン。無料枠の消費ペースを見るために記録する。 */
export type Usage = { inputTokens: number; outputTokens: number };

/**
 * JSON を返させる生成。responseSchema で形を固定するので、
 * 「説明文が混ざって JSON.parse に失敗する」よくある事故を避けられる。
 *
 * 使用量を一緒に返すのは、記録する場所（ワーカー）に DB のクライアントがあり、
 * ここには無いため。ここで記録しようとすると、この薄いラッパが DB を持つことになる。
 */
export async function generateJson<T>(opts: {
  /** 誰の鍵で呼ぶか（lib/ai/keys.ts）。 */
  apiKey: string;
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  /**
   * 出力の上限。JSON は途中で切れると丸ごと壊れる（parse できない）ので、
   * 「収まる長さを指示する」だけでなく、ここでも天井を決めておく。
   *
   * 注意: この上限は**思考トークンも含む**。3.5-flash は答える前に考えるので、
   * 上限を絞ると思考だけで使い切って本文が数百字で切れる（実際に踏んだ）。
   * 絞るなら thinkingBudget も一緒に絞ること。
   */
  maxOutputTokens?: number;
  /** 思考に使ってよいトークン。0 で思考なし。maxOutputTokens を絞るときは必ず添える。 */
  thinkingBudget?: number;
}): Promise<{ data: T; usage: Usage }> {
  try {
    const res = await geminiClient(opts.apiKey).models.generateContent({
      model: opts.model,
      contents: opts.prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: opts.schema,
        maxOutputTokens: opts.maxOutputTokens,
        ...(opts.thinkingBudget === undefined
          ? {}
          : { thinkingConfig: { thinkingBudget: opts.thinkingBudget } }),
      },
    });

    const text = res.text;
    if (!text) throw new Error('Gemini が空の応答を返しました');

    // 上限で打ち切られると JSON が閉じないまま返る。parse の生エラー
    // （Unterminated string …）だけ見ても原因が分からないので、ここで言い換える。
    if (res.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      const thoughts = res.usageMetadata?.thoughtsTokenCount ?? 0;
      throw new Error(
        `出力が上限で打ち切られました（本文${text.length}文字・思考${thoughts}トークン）。` +
          '素材を減らすか、maxOutputTokens と thinkingBudget を見直してください',
      );
    }

    return {
      data: JSON.parse(text) as T,
      usage: {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  } catch (err) {
    classify(err);
  }
}

export const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL ?? 'gemini-3.5-flash-lite';
export const SCRIPT_MODEL = process.env.GEMINI_SCRIPT_MODEL ?? 'gemini-3.5-flash';
