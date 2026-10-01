import { generateJson, SCRIPT_MODEL, type Usage } from './gemini';
import { DEFAULT_LANGUAGE, languageName } from '@/lib/language';

/**
 * 2話者の対話台本とスライドを、1回の生成でまとめて作る。
 *
 * 分けて2回呼ばないのは、台本とスライドの切れ目が一致していないと
 * 同期再生が成立しないため。1回で出させて、各発話に「どのスライドを出しているか」を
 * 持たせれば、再生側は「クリップが終わったら次へ」を見るだけで済む。
 *
 * 話者は2人。NotebookLM の音声概要と同じ「聞き手が素朴に訊いて、話し手が答える」
 * 形にすると、専門外の内容でも耳で追える。
 */

/** 台本の1発話。スライド1枚に複数の発話がぶら下がる。 */
export type ScriptLine = {
  speaker: 'A' | 'B';
  text: string;
  /** 何枚目のスライドを出しているか（slides の添字）。 */
  slide: number;
};

export type Slide =
  | { type: 'title'; title: string; subtitle?: string }
  | { type: 'bullets'; heading: string; bullets: string[] }
  | { type: 'quote'; text: string; cite?: string };

export type ScriptResult = {
  lines: ScriptLine[];
  slides: Slide[];
  usage: Usage;
};

/** 話者の役どころ。プロンプトと TTS の声の割り当ての両方で使う。 */
export const SPEAKERS = {
  A: { name: 'アオイ', role: '進行役。話題を切り出し、要点をまとめる' },
  B: { name: 'ケン', role: '聞き手。専門外の立場から素朴な疑問を投げ、噛み砕かせる' },
} as const;

/**
 * 音声の作り。
 *
 * `dialogue` は NotebookLM の音声概要と同じ形で、専門外の話題でも耳で追いやすい。
 * ただし相槌と質問のぶんだけ長くなる。`solo` は1人が淡々と読むので、
 * 同じ中身でも短く済み、内容を早く取りたいときに向く。好みが分かれるので選べるようにした。
 */
export type VoiceMode = 'dialogue' | 'solo';

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  dialogue: '2人の対話（聞き手が質問する形。耳で追いやすい）',
  solo: '1人の語り（淡々と読む。同じ中身でも短い）',
};

/**
 * 出力の上限。
 *
 * JSON は途中で切れると parse できず、生成そのものが丸ごと無駄になる。
 * 指示で長さを頼むだけでは効かなかった（8件のダイジェストで8万字を超える台本を
 * 書いてきて、出力の上限で切れた）ので、渡す素材の量（textLimit）と
 * maxOutputTokens、そして受け取ってからの切り詰めの3段で抑える。
 *
 * **`maxItems` は項目3つまでのオブジェクトなら使える。**7つにすると
 * Gemini が 400 INVALID_ARGUMENT を返す（理由は本文に出ないので原因不明の400に見える）。
 * だからスライドを3項目に平たくして（buildSchema）、上限を効かせている。
 * ここを戻して項目を増やすと、`maxItems` を諦めることになり、
 * 「同じスライドを延々と繰り返して出力を使い切る」壊れ方がまた起きる。
 */
const MAX_SLIDES = 12;
/**
 * 発話数の天井。70 では15分の番組が収まらない（5100字を70個に割ると
 * 1発話73字が下限になり、密度を上げようとすると字数のほうが削られる）。
 * normalizeLines もここで切るので、プロンプトの上限だけ上げても効かない。
 */
const MAX_LINES = 80;

/**
 * maxOutputTokens は思考トークンも含む。8192 にしたら思考だけで使い切って
 * 本文が716字で切れた。台本3000字なら本文は3000トークン前後なので、
 * 思考ぶんを別に見込んで広めに取り、思考自体も上限を決めておく。
 */
const MAX_OUTPUT_TOKENS = 24_576;
const THINKING_BUDGET = 4_096;

/**
 * モデルに返させる形。**画面で使う `Slide` とはわざと別**にしてある。
 *
 * 理由は `maxItems`。項目の多いオブジェクトに付けると Gemini が
 * 400 INVALID_ARGUMENT を返すが、項目3つなら通る（このファイル上部の注記）。
 * 以前のスライドは項目7つ（type/title/subtitle/heading/bullets/text/cite）で
 * 上限を付けられず、**モデルが同じスライドを延々と繰り返して出力を使い切った**
 * ——実測で23302トークン・73639字が全部同じ `bullets` の反復だった。
 * 記事1本から音声を作ると必ずこれで落ちていた。
 *
 * そこで「見出し1つ＋本文の行」という3項目に平たくして、上限を効かせる。
 * 型ごとの違いは受け取ってから組み立て直す（toSlide）。
 */
function buildSchema(maxSlides: number, maxLines: number) {
  return {
    type: 'object',
    properties: {
      slides: {
        type: 'array',
        maxItems: maxSlides,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['title', 'bullets', 'quote'] },
            heading: { type: 'string' },
            body: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'heading', 'body'],
        },
      },
      lines: {
        type: 'array',
        maxItems: maxLines,
        items: {
          type: 'object',
          properties: {
            speaker: { type: 'string', enum: ['A', 'B'] },
            text: { type: 'string' },
            slide: { type: 'integer' },
          },
          required: ['speaker', 'text', 'slide'],
        },
      },
    },
    required: ['slides', 'lines'],
  };
}

/** モデルから受け取るスライド。 */
type RawSlide = { type?: string; heading?: string; body?: string[] };

/**
 * 平たい形から画面用の `Slide` に戻す。
 *
 *   title   heading = 主題、body[0] = 副題
 *   bullets heading = 見出し、body = 箇条書き
 *   quote   heading = 出典（省略可）、body[0] = 引用
 */
function toSlide(raw: RawSlide): Slide | null {
  const heading = String(raw.heading ?? '').trim();
  const body = (raw.body ?? []).map((b) => String(b).trim()).filter(Boolean);

  if (raw.type === 'quote' && body.length > 0) {
    return { type: 'quote', text: body[0], cite: heading || undefined };
  }
  if (raw.type === 'title' && heading) {
    return { type: 'title', title: heading, subtitle: body[0] || undefined };
  }
  if (heading && body.length > 0) {
    return { type: 'bullets', heading, bullets: body };
  }
  // 見出しだけ来たときは表紙として拾う。捨てるより出したほうがまし。
  return heading ? { type: 'title', title: heading } : null;
}

export type ScriptSource = {
  title: string;
  /** 記事ごとの素材。ダイジェストなら複数件。 */
  articles: { title: string; url: string; bullets: string[]; text: string }[];
};

/**
 * 1本の作り方。素材の件数だけで決まる。
 *
 * **記事1本の深掘り（deep）と、複数をまとめた番組（roundup）は別物**として扱う。
 * 以前は「記事が多いときは1件あたりを短くして収める」としか言っていなかったので、
 * ダイジェストは**記事1本につきスライド1枚の読み上げの列**になっていた。
 * 2026-09-01 の6件で実測すると、8枚のうち6枚が記事そのままの見出しで、
 * 同じ審議会の第1部会と第2部会が別々の枠に分かれていた——聴くと
 * 「ニュースを1本ずつ読み上げている」だけに聞こえる。
 * 欲しいのは「ここまでのニュースに1本で追いつく番組」なので、roundup では
 * 記事の並びではなく**話題**で括り直させる。
 */
type Plan = {
  kind: 'deep' | 'roundup';
  /** 台本全体の目安（字）。 */
  chars: number;
  /** 読み上げるとおよそ何分か。プロンプトに書くための数字。 */
  minutes: number;
  /** 話題の数。roundup では話題、deep では論点。表紙とまとめを除いたスライドの数。 */
  topics: number;
  slides: number;
  /** 発話数の上限。schema の maxItems とプロンプトの「◯個以内」の両方に使う。 */
  lines: number;
  /** 1話題あたりの字数。**合計より、こちらのほうが守られる**（下の注記）。 */
  charsPerTopic: number;
  /** 1記事あたりに渡す本文の長さ。 */
  textLimit: number;
};

/**
 * 読み上げの速さ。**実測から出す。**
 *
 * 手元の音声3本で 1678字/307秒・1116字/199秒・532字/90秒 ＝ 328〜355字/分だった。
 * 間の取り方で少し動くので真ん中を取る。ここを楽観的に見積もると、
 * 「15分ぶん」と頼んだものが10分で終わる。
 */
const CHARS_PER_MINUTE = 340;

/**
 * まとめ番組の尺。「1本1本のニュースではなく、15分くらいの今までのまとめ」（2026-09-01 の指示）。
 *
 * 件数から出して上限で頭打ちにする。上限を置くのは、素材が少ない日に尺を
 * 埋めさせないため——空いた尺は言い換えの水増しになり、JSON が長くなるだけで
 * 中身は増えない（記事1本で8分を固定していた頃、出力の上限で毎回落ちていた）。
 * 下限があるのは、2件しか無い日でも番組の形（冒頭・話題・締め）は要るため。
 */
const ROUNDUP_MAX_MINUTES = 15;
const ROUNDUP_MIN_MINUTES = 6;
/** 1記事あたりに見込む分数。8件で上限の15分、6件でちょうど15分になる。 */
const MINUTES_PER_ARTICLE = 2.5;

/**
 * 冒頭（全体の見取り図）と締めに使う字数。話題ぶんの割り当てから先に取っておく。
 * ここを引かずに割ると、話題の合計だけで目安の字数を使い切る。
 */
const OPENING_CHARS = 350;
const CLOSING_CHARS = 250;

export function plan(articleCount: number): Plan {
  // 記事1本の深掘り。数字は据え置き（2400字で実測1116〜1678字）。
  if (articleCount <= 1) {
    return {
      kind: 'deep',
      chars: 2_400,
      minutes: 7,
      topics: 4,
      slides: 5,
      lines: 28,
      charsPerTopic: Math.round((2_400 - OPENING_CHARS - CLOSING_CHARS) / 4),
      // 1件しか無いので、渡せる本文は全部渡す。
      textLimit: 9_000,
    };
  }

  const minutes = Math.min(
    ROUNDUP_MAX_MINUTES,
    Math.max(ROUNDUP_MIN_MINUTES, Math.round(articleCount * MINUTES_PER_ARTICLE)),
  );
  const chars = minutes * CHARS_PER_MINUTE;

  // 話題は記事より少なくする。**同数にすると必ず1記事1話題に戻る**
  // （枠がちょうど足りるので、モデルはまとめる理由が無くなる）。
  const topics = Math.min(Math.max(Math.ceil((articleCount * 2) / 3), 2), MAX_SLIDES - 2);

  return {
    kind: 'roundup',
    chars,
    minutes,
    topics,
    slides: topics + 2,
    // 1発話60字でも足りるだけの枠を渡す。ここが窮屈だと、字数を守るために
    // 1発話が200字を超えて、聴くと息継ぎの無い読み上げになる。
    lines: Math.min(Math.ceil(chars / 60), MAX_LINES),
    charsPerTopic: Math.round((chars - OPENING_CHARS - CLOSING_CHARS) / topics),
    /**
     * 話題ごとに深く話させるので、素材も以前（1000字）より厚く渡す。
     * 薄いまま長さだけ頼むと、書かれていないことで埋めにくる。
     * ただし青天井にはしない——8件に4000字ずつ渡した頃、モデルが素材の量に
     * 引きずられて8万字の台本を書き、出力の上限で JSON ごと壊れた。
     */
    textLimit: articleCount <= 3 ? 3_500 : 2_500,
  };
}

function buildPrompt(
  source: ScriptSource,
  extra: string,
  mode: VoiceMode,
  language: string,
): string {
  const p = plan(source.articles.length);
  const limit = p.textLimit;
  const solo = mode === 'solo';
  const roundup = p.kind === 'roundup';
  const count = source.articles.length;

  const body = source.articles
    .map((a, i) =>
      [
        `<article index="${i + 1}">`,
        `タイトル: ${a.title}`,
        a.bullets.length ? `要点:\n${a.bullets.map((b) => `- ${b}`).join('\n')}` : '',
        limit > 0 ? '本文（抜粋）:' : '',
        limit > 0 ? a.text.slice(0, limit) : '',
        '</article>',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');

  return [
    solo
      ? 'あなたはニュース番組の構成作家です。次の記事群から、1人の語りによる'
      : 'あなたはニュース番組の構成作家です。次の記事群から、2人の対話による',
    // 言語は設定に従う。ここを日本語で直書きしていたので、設定を英語にすると
    // 要約は英語・音声は日本語という食い違いが起きていた。
    `音声番組の台本と、それに合わせて表示するスライドを作ってください。` +
      `台本もスライドの文字も、すべて${languageName(language)}で書くこと。`,
    '',
    solo
      ? // 話者は1人でも、出力の形（speaker を持つ配列）は共通にしておく。
        // スキーマを分けると受け取り側も分岐が増える。
        `話者は${SPEAKERS.A.name}（${SPEAKERS.A.role}）ただ1人。` +
        'lines の speaker は全て "A" にすること。"B" を使ってはいけない。' +
        '相槌・質問・呼びかけは入れず、聴き手に語りかける独白にする。'
      : `話者A = ${SPEAKERS.A.name}（${SPEAKERS.A.role}）\n話者B = ${SPEAKERS.B.name}（${SPEAKERS.B.role}）`,
    '',
    '## 分量（守ること）',
    `- スライドは${p.slides}枚ちょうど、発話は${p.lines}個以内。これを超えてはいけない。`,
    // 字数で言い切る。分数だけだと、素材が少ないときに尺を埋めようとして膨らむ。
    // 上限だけ言うと、モデルは上限を「守るべき天井」としか読まない。実測で
    // 2400字と頼んで1116字（約3分）しか書かなかった。下限も添えて幅で頼む。
    // ただし**禁止するのは超過だけ**にしておく。下限を絶対の決まりにすると、
    // 素材が薄い記事で言い換えを増やして尺を埋めにいく。
    `- lines の text の合計は${Math.round(p.chars * 0.9)}〜${p.chars}字を目安にする。` +
      `**${p.chars}字を超えてはいけない。**（読み上げて約${p.minutes}分）`,
    // **合計だけ頼んでも届かない。**6件のダイジェストで4400字と頼んで3545字（81%）。
    // 一方でスライドごとの字数は 344/509/459/465/467/512/501/288 とよく揃っていた——
    // モデルは「全体で何字」より「この枠に何字」のほうを守る。だから割り当てで言う。
    roundup
      ? `- **1つの話題につき${p.charsPerTopic}字前後を使うこと。**これが一番大事な決まり。` +
        `冒頭は${OPENING_CHARS}字前後、締めは${CLOSING_CHARS}字前後。` +
        `どの話題も、短くて${Math.round(p.charsPerTopic * 0.8)}字は話すこと。`
      : `- 1つの論点につき${p.charsPerTopic}字前後を使うこと。`,
    '- 素材に書かれている限り、目安の下のほうで切り上げず、しっかり分量を使うこと。',
    roundup
      ? '- 分量が足りないときは、話題を増やすのではなく1つの話題を深く話して埋めること。' +
        'ただし書かれていないことで尺を埋めたり、同じ話を言い換えて伸ばしたりしてはいけない。'
      : // 「短くてよい」と言っていたら、要点を3つ読み上げるだけの90秒になっていた。
        // 尺を埋めるなという歯止めは残しつつ、掘る方向へ向ける。
        '- 素材は1件。その1件を掘り下げることに字数を使うこと。' +
        'ただし書かれていないことで尺を埋めたり、同じ話を言い換えて伸ばしたりしてはいけない。',
    // ここが 2026-09-01 の指示（「1本1本のニュースではなく、15分くらいの
    // 今までのニュースまとめに」）の中心。番組の骨格を先に決めて渡す。
    roundup ? '## 番組の作り（まとめ番組）' : null,
    roundup
      ? `- これは「ここまでのニュースに1本で追いつくためのまとめ番組」。` +
        `**記事を1本ずつ順に紹介する形にしてはいけない。**`
      : null,
    roundup
      ? `- 冒頭（スライド0）で、今回扱う全体像を先に言い切る。何が起きた日なのかが` +
        `これだけで分かるようにする。`
      : null,
    roundup
      ? `- 続く${p.topics}枚は話題ごとに1枚。**関連する記事は同じ話題にまとめて1つの流れとして話す**` +
        `（同じ会議の別の部会、同じテーマの続報、同じ分野の複数件などは分けない）。`
      : null,
    roundup
      ? `- **${count}件すべてに必ず触れること。**まとめた結果、一度も出てこない記事があってはいけない。`
      : null,
    roundup
      ? '- 話題から話題へ移るときは一言でつなぐ。「次のニュースです」の繰り返しにしない。' +
        '前の話題との関係（似ている・逆・同じ流れ）が言えるなら言う。'
      : null,
    roundup
      ? '- 話題ごとに「何があったか → なぜ今それが起きているか → 何が変わるか」の順で話す。' +
        '見出しの読み上げで終わらせない。'
      : null,
    roundup ? '- 最後の1枚は、全体を通して見えることを一言でまとめる。' : null,
    '',
    '## スライド',
    `- ${p.slides}枚ちょうど作ること。少なく済ませてはいけない。`,
    '- 先頭は必ず type="title" の1枚。全体の主題を出す。',
    roundup
      ? `- 続く${p.topics}枚は type="bullets" を話題ごとに1枚。**heading は話題の名前**にする` +
        '（記事の見出しをそのまま写さない。2件をまとめた話題なら、2件に共通する言い方にする）。' +
        '最後の1枚は全体を振り返るまとめにする。'
      : // 記事1本を1枚で片付けると、3行の箇条書きに要約されて終わる。
        // 論点で割らせると、台本のほうも1論点ずつ掘る形になる。
        `- 続く${p.slides - 1}枚は、この記事を**論点で割って**1枚ずつ。` +
        '「何が起きたか」「なぜそうなったか」「何が変わるか」「引っかかる点・今後」のように、' +
        '別々の切り口にする。同じ話を言い換えた2枚を作ってはいけない。',
    '- 特に印象的な一文があれば type="quote" を挟んでよい（多用しない）。',
    '- bullets は3〜4個。1個あたり40字以内。',
    // 「重要だ」「注目される」だけのスライドは、読んでも何も分からない。
    '- **具体を書く。** 数字・固有名詞・日付・地名を、記事にあるものは必ず入れる。' +
      '「大きな影響」「注目が集まる」のような、中身の無い言い回しで枠を埋めないこと。',
    '',
    '## 台本',
    '- lines は発話の並び。各発話に slide（そのとき表示しているスライドの添字、0始まり）を付ける。',
    '- slide は前の発話と同じか+1のみ。戻ってはいけない。スライドは必ず順に進む。',
    '- 最後のスライドまで必ず進めること。全部の発話が slide=0 のままではいけない。',
    roundup
      ? '- ある話題を話している間は、その話題のスライドを指すこと。'
      : '- ある記事の話をしている間は、その記事のスライドを指すこと。',
    solo
      ? '- 1発話は60〜140字程度。長い説明は文を切って並べる。相手はいないので問いかけない。'
      : '- 1発話は60〜140字程度。長い説明は相手の相槌や質問を挟んで分ける。',
    '- 「何が新しいのか」「なぜ重要か」を軸にする。記事に書かれていないことは足さない。',
    // 薄い台本は、たいてい「要点を3つ読み上げて終わり」になっている。
    // 素材にある具体を必ず口に出させると、聴いて分かる密度になる。
    '- **記事にある具体を必ず話す。** 数字・固有名詞・日付・場所・関係者の発言は、' +
      '要約せずにそのまま出す。「大きな影響がありそうです」で済ませない。',
    '- 要点を並べるだけで終わらせない。それぞれについて、' +
      '背景（なぜ今そうなったか）と、読み手にとっての意味（何が変わるか）まで踏み込む。',
    roundup
      ? '- 記事の順番に引きずられない。話題の中では、記事をまたいで話をつないでよい。'
      : '- 素材は1件なので、掘り下げるほうへ使うこと。同じ内容を言い換えて尺を伸ばさない。',
    '- 冒頭で全体を予告し、最後に一言でまとめる。',
    '- 読み上げられるので、記号や箇条書き、URL、英略語の羅列は避けて話し言葉にする。',
    // スライドは音声の付随物で、画面を見ずに聴いている時間のほうが長い
    // （通勤中・家事中）。「スライドを見ていきましょう」と言われても何も起きない。
    // slide の添字は付けさせる必要があるので、スライドの存在自体は伝えたうえで、
    // 口に出すことだけを禁じる。
    '- **スライドの話をしてはいけない。** 聴き手は画面を見ていない前提で書くこと。' +
      '「スライドを見ていきましょう」「画面に出ているように」「図の通り」のような、' +
      '画面への言及や、見ることを促す言い方は一切使わない。' +
      'スライドに書いた内容も、そこに書いてあると言わずに、自分の言葉として話す。',
    extra ? `\n## 追加の指示\n${extra}` : '',
    '',
    `# 素材（${source.articles.length}件）`,
    `全体の主題: ${source.title}`,
    '',
    body,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generateScript(
  /** 作らせた本人の鍵（lib/ai/keys.ts）。 */
  apiKey: string,
  source: ScriptSource,
  extra = '',
  mode: VoiceMode = 'dialogue',
  /** 出力の言語。設定（settings.summary_language）から渡す。 */
  language: string = DEFAULT_LANGUAGE,
): Promise<ScriptResult> {
  // 上限はプロンプトとスキーマの両方で言う。プロンプトだけだと守られなかった。
  const p = plan(source.articles.length);

  const { data, usage } = await generateJson<{ slides: RawSlide[]; lines: ScriptLine[] }>({
    apiKey,
    model: SCRIPT_MODEL,
    prompt: buildPrompt(source, extra, mode, language),
    schema: buildSchema(p.slides, p.lines),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingBudget: THINKING_BUDGET,
  });

  const slides = normalizeSlides(data.slides ?? []);

  // スライドが1枚も取れなくても、表紙を1枚こしらえて先に進む。
  // 欲しいのは音声のほうで、スライドはその添え物。ここで諦めると
  // 生成に使ったぶんが丸ごと無駄になる。
  const usable = slides.length > 0 ? slides : [{ type: 'title' as const, title: source.title }];
  const raw = normalizeLines(data.lines ?? [], usable.length);
  // 1人の語りを頼んでも B が混じることがある。プロンプトの言いつけだけに
  // 頼ると、TTS 側で「いないはずの話者」の声を割り当てる羽目になる。
  const lines = mode === 'solo' ? raw.map((l) => ({ ...l, speaker: 'A' as const })) : raw;

  if (lines.length === 0) {
    // 何を受け取って何が残らなかったのかが分からないと直しようがない。
    throw new Error(
      `台本が空です（受信: スライド${(data.slides ?? []).length}件・発話${(data.lines ?? []).length}件）`,
    );
  }

  return { lines, slides: usable, usage };
}

/**
 * 受け取ったスライドを画面用の形に直し、枚数を切る。
 * 上限はスキーマ側の maxItems でも掛けてあるが、こちらでも念のため守る。
 */
function normalizeSlides(raw: RawSlide[]): Slide[] {
  const out: Slide[] = [];
  for (const r of raw) {
    const slide = toSlide(r);
    if (slide) out.push(slide);
    if (out.length >= MAX_SLIDES) break;
  }
  return out;
}

/**
 * 発話の整形。
 *
 * slide が範囲外だったり戻ったりすると、再生側でスライドが飛ぶ・巻き戻る。
 * ここで「前の値以上」「範囲内」に丸めておけば、再生側は素直に前から出すだけで済む。
 */
function normalizeLines(raw: ScriptLine[], slideCount: number): ScriptLine[] {
  const out: ScriptLine[] = [];
  let current = 0;

  for (const line of raw) {
    const text = String(line.text ?? '').trim();
    if (!text) continue;

    const wanted = Number.isFinite(line.slide) ? Math.trunc(line.slide) : current;
    current = Math.min(Math.max(wanted, current), Math.max(slideCount - 1, 0));

    out.push({
      speaker: line.speaker === 'B' ? 'B' : 'A',
      text,
      slide: current,
    });

    if (out.length >= MAX_LINES) break;
  }

  return out;
}
