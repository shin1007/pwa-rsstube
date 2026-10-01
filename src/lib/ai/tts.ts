import lamejs from '@breezystack/lamejs';
import { geminiClient, RetryableError, type Usage } from './gemini';
import { SPEAKERS, type ScriptLine, type VoiceMode } from './script';

/**
 * マルチスピーカーTTS と、その出力を MP3 にするところ。
 *
 * 合成の単位はスライド1枚ぶん。1発話ごとに呼ぶと、8分の番組で数十回の
 * リクエストになって無料枠の1日あたり回数を食い潰す。スライド単位なら
 * 1本あたり10回前後で済み、しかもクリップの切れ目がそのまま
 * スライドの切り替わりになる（タイミングの推定が要らなくなる）。
 *
 * Gemini が返すのは生のPCM（audio/l16 24kHz モノラル）で、そのままでは
 * 1秒48KBある。8分で23MBになり Storage の無料枠1GBをすぐ削るので、
 * 64kbps の MP3 にしてから保存する（実測で約6分の1）。
 */

export const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? 'gemini-3.1-flash-tts-preview';

/** 返ってくるPCMの形式。ヘッダが無いので、こちらが知っている前提で扱う。 */
const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

/** MP3 のビットレート。声だけなので 64kbps で十分聞ける。 */
const MP3_KBPS = 64;

/**
 * 選べる声。Gemini TTS の prebuilt voice 名で、`samples/voices/` に
 * 同じ原稿を読ませた聴き比べがある（`npm run voices` で作り直せる）。
 *
 * 説明を付けているのは、名前だけでは選びようがないため。日本語の
 * 聞こえ方は好みが割れるので、最後は聴いて決めてもらう。
 */
export const TTS_VOICES: Record<string, string> = {
  Kore: 'Kore（落ち着いた女性寄り。既定）',
  Puck: 'Puck（軽快な男性寄り。既定の聞き手）',
  Aoede: 'Aoede（やわらかい女性寄り）',
  Charon: 'Charon（低めの男性寄り）',
  Leda: 'Leda（明るい女性寄り）',
  Orus: 'Orus（落ち着いた男性寄り）',
};

/**
 * 声の既定。環境変数を残してあるのは、設定の行が無いユーザーと、
 * 声を持たない古い media（0032 より前）のため。
 * 好みはユーザーごとなので、通常は settings 側の値が渡ってくる。
 */
export const DEFAULT_VOICE_A = process.env.GEMINI_TTS_VOICE_A ?? 'Kore';
export const DEFAULT_VOICE_B = process.env.GEMINI_TTS_VOICE_B ?? 'Puck';

/** 知らない名前を渡すと API が 400 を返すので、表に無いものは既定へ落とす。 */
export function normalizeVoice(name: unknown, fallback: string): string {
  return typeof name === 'string' && name in TTS_VOICES ? name : fallback;
}

export type Synthesized = {
  mp3: Buffer;
  /** 秒。PCM の長さから出すので実測値。 */
  durationSec: number;
  usage: Usage;
};

/** 読み上げさせる台本テキスト。話者名を頭に置くのが multi-speaker の指定方法。 */
export function toSpeechText(lines: ScriptLine[]): string {
  return lines
    .map((l) => `${l.speaker === 'B' ? SPEAKERS.B.name : SPEAKERS.A.name}: ${l.text}`)
    .join('\n');
}

export async function synthesize(
  /** 作らせた本人の鍵（lib/ai/keys.ts）。 */
  apiKey: string,
  lines: ScriptLine[],
  mode: VoiceMode = 'dialogue',
  /**
   * 使う声。media に焼いた値を渡すこと（0032）。
   *
   * **1本の音声はセグメントごとに何度も合成する。**途中で設定を見に行くと、
   * 設定を変えた瞬間から後半だけ声が変わる。
   */
  voices: { a?: string | null; b?: string | null } = {},
  /**
   * 打ち切りの合図。**必ず渡すこと。**
   *
   * 合成は1回に数十秒かかる。上限が無いと Vercel の maxDuration(60秒)を
   * 超えて関数ごと落とされ、running のジョブが宙に浮く
   * （FUNCTION_INVOCATION_TIMEOUT。実際に起きた）。落とされると
   * complete も fail も呼べないので、拾い直しの15分待ちになる。
   */
  signal?: AbortSignal,
): Promise<Synthesized> {
  if (lines.length === 0) throw new Error('読み上げる台本がありません');

  const solo = mode === 'solo';

  const prompt = solo
    ? ['次の文章を、自然な間合いで読み上げてください。', '', lines.map((l) => l.text).join('\n')].join('\n')
    : [
        '次の2人の会話を、自然な間合いで読み上げてください。',
        '話者名は読み上げないこと。',
        '',
        toSpeechText(lines),
      ].join('\n');

  /**
   * 1人のときは multiSpeakerVoiceConfig を使わない。
   *
   * 話者が1人しかいないのに複数話者の設定を渡すと、モデルが台本の中に
   * 話者の切り替わりを探しに行く。名前を前置きしない素の文章を渡すぶん、
   * 単一話者の設定のほうが素直に読む。
   */
  // 知らない名前をそのまま渡すと API が 400 を返す。古い media は声を
  // 持たない（null）ので、そのときも既定へ落ちる。
  const voiceA = normalizeVoice(voices.a, DEFAULT_VOICE_A);
  const voiceB = normalizeVoice(voices.b, DEFAULT_VOICE_B);

  const speechConfig = solo
    ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceA } } }
    : {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: SPEAKERS.A.name, voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceA } } },
            { speaker: SPEAKERS.B.name, voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceB } } },
          ],
        },
      };

  let res;
  try {
    res = await geminiClient(apiKey).models.generateContent({
      model: TTS_MODEL,
      contents: prompt,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig,
        abortSignal: signal,
      },
    });
  } catch (err) {
    // 要約と同じ扱い。429 や 5xx は後で再試行する価値がある。
    const message = err instanceof Error ? err.message : String(err);
    if (/\b(429|500|502|503|504)\b/.test(message) || /RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(message)) {
      throw new RetryableError(message);
    }
    throw err instanceof Error ? err : new Error(message);
  }

  const data = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) throw new Error('TTS が音声を返しませんでした');

  const pcm = Buffer.from(data, 'base64');

  return {
    mp3: pcmToMp3(pcm),
    durationSec: pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE),
    usage: {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

/**
 * 生PCM(L16 モノラル) を MP3 にする。
 *
 * ffmpeg を使わないのは、Vercel の関数にバイナリを持ち込みたくないため。
 * lamejs は純JSなので、そのままサーバーレスで動く。
 */
export function pcmToMp3(pcm: Buffer): Buffer {
  // Buffer から Int16Array を作るとき、byteOffset を渡さないと
  // プール済みバッファの先頭を読んでしまう（Node の Buffer は共有プール上にある）。
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));

  const encoder = new lamejs.Mp3Encoder(1, SAMPLE_RATE, MP3_KBPS);
  const chunks: Buffer[] = [];
  // MP3 の1フレームぶん。この単位で渡すのが lamejs の作法。
  const BLOCK = 1152;

  for (let i = 0; i < samples.length; i += BLOCK) {
    const buf = encoder.encodeBuffer(samples.subarray(i, i + BLOCK));
    if (buf.length > 0) chunks.push(Buffer.from(buf));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(Buffer.from(tail));

  return Buffer.concat(chunks);
}
