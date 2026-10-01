import { generateJson, SUMMARY_MODEL, type Usage } from './gemini';
import { languageName } from '@/lib/language';

/**
 * 記事の要約。
 *
 * 一覧を開いた瞬間に「読むべきか」を判断できることが目的なので、
 * 要点は短く、記事を開かなくても意味が通る文にさせる。
 *
 * **重要度スコアは付けさせない**（0037）。0〜100 を出させて一覧の並べ替えと
 * ダイジェストの選抜に使っていたが、重要度は記事の属性ではない——同じ記事でも
 * 職業や立場が違えば重さは違う。読み手との関係で決まるものを記事の側に1つの
 * 数値として持たせたのが誤りだった。判断は読む人に返し、こちらは
 * 「何が書いてあるか」だけを渡す。
 *
 * 無料枠のRPD(1日あたりリクエスト数)を節約するため、複数記事を
 * 1リクエストにまとめて投げる。
 */

export type SummaryInput = {
  id: string;
  title: string;
  /** 本文（抽出できていれば本文、できていなければRSSの抜粋）。 */
  text: string;
  /** false のとき、モデルに「これは抜粋である」と伝えて過剰な断定を避けさせる。 */
  contentOk: boolean;
};

export type SummaryOutput = {
  id: string;
  /**
   * 設定言語での見出し（0023）。原語のタイトルは articles.title に残る。
   * 元からその言語なら、ほぼそのまま返ってくる。
   */
  title_ja: string;
  bullets: string[];
  tags: string[];
};

/** 1リクエストにまとめる記事数。多すぎると出力が雑になるので控えめに。 */
export const BATCH_SIZE = 5;

/** 1記事あたりに渡す本文の長さ。長文をそのまま入れると入力トークンを食う。 */
const TEXT_LIMIT = 6_000;

const SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title_ja: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title_ja', 'bullets', 'tags'],
      },
    },
  },
  required: ['summaries'],
};

function buildPrompt(articles: SummaryInput[], language: string): string {
  const body = articles
    .map((a) => {
      /**
       * **本文が取れなかったことをモデルに伝えない。**
       *
       * 以前はここに「(注: 本文が取得できず、RSSの抜粋のみ)」と書いていた。
       * そのせいでモデルが素材の乏しさのほうを要約し、実データで30件が
       * 「本文が取得できずRSSの抜粋のみのため、詳細な内容を確認することは
       * できない。」だけになっていた。**禁止する一文をプロンプトに足すだけでは
       * 足りなかった**（作り直したら24件→5件に減ったが、ゼロにはならない）。
       * 注記そのものを消すのがいちばん効く。読み手が知りたいのは記事の中身で
       * あって、こちらの取得結果ではない。
       *
       * 短い素材から短い要約が出るのは正しい振る舞いなので、そのまま出させる。
       */
      return [
        `<article id="${a.id}">`,
        `タイトル: ${a.title}`,
        '本文:',
        a.text.slice(0, TEXT_LIMIT),
        '</article>',
      ].join('\n');
    })
    .join('\n\n');

  return [
    'あなたはRSSリーダーの要約担当です。以下の各記事について、',
    // コード（ja）ではなくその言語自身の呼び名で頼む。コードのままだと揺れる。
    `すべて${languageName(language)}で書いてください。` +
      `記事が何語で書かれていても、出力は${languageName(language)}にすること。`,
    '',
    // 見出しも訳させる。呼び出しは増えず、出力が数十トークン伸びるだけ。
    // これが無いと、英語のフィードではダイジェストの見出しが全部英語になり、
    // NotebookLM に「日本語で話して」と頼んでも素材に引きずられる。
    `- title_ja: 記事の見出しを${languageName(language)}で。` +
      '元からその言語ならそのまま返す。40字以内。内容を表す簡潔な見出しにし、原題の直訳に拘らなくてよい。',
    '- bullets: 要点を2〜3個。各40〜80字程度。記事を開かなくても内容がわかる具体的な文にすること。',
    '  「〜について述べている」のようなメタな説明ではなく、何が起きたか・何が主張されているかを直接書く。',
    '- tags: 内容を表す短いタグを1〜4個。一般的な語を使い、記事ごとに揺れないようにする。',
    // **重要度・おすすめ度のたぐいを足さないこと。** 読み手が誰かを知らないまま
    // 出した点数は、読む人の判断を助けるより先に置き換えてしまう（0037）。
    '記事の価値を評価したり、重要度・おすすめ度のような点数を付けたりしないこと。',
    '書くのは「何が書いてあるか」だけにする。',
    '',
    // **「本文が取れなかった」ことを書かせない。**
    // 以前は「抜粋のみ」と注記だけ渡していたので、モデルが素材の乏しさのほうを
    // 要約してきた（実データで30件が「本文が取得できずRSSの抜粋のみのため、
    // 詳細な内容を確認することはできない。」だけになっていた。漫画のフィードは
    // 本文が無いのが当たり前なので、全話がこれで埋まる）。読み手が知りたいのは
    // 記事の中身であって、こちらの取得結果ではない。
    '本文がRSSの抜粋のみの記事も、抜粋からわかる範囲だけを書き、推測で補わないこと。',
    'ただし「本文が取得できない」「詳細は不明」のような、素材の乏しさそのものを',
    '説明する文は書かないこと。書けることが少なければ bullets を1個にしてよい。',
    'タイトルしか手がかりが無いなら、タイトルから確実に言えることだけを1文で書く。',
    'id は入力の値をそのまま返すこと。',
    '',
    body,
  ].join('\n');
}

export async function summarizeBatch(
  /** 誰の鍵で呼ぶか。記事は共通なので、購読者のうちの誰か（lib/ai/keys.ts）。 */
  apiKey: string,
  articles: SummaryInput[],
  language = 'ja',
): Promise<{ results: SummaryOutput[]; model: string; usage: Usage }> {
  if (articles.length === 0) {
    return { results: [], model: SUMMARY_MODEL, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  const { data, usage } = await generateJson<{ summaries: SummaryOutput[] }>({
    apiKey,
    model: SUMMARY_MODEL,
    prompt: buildPrompt(articles, language),
    schema: SCHEMA,
  });

  const known = new Set(articles.map((a) => a.id));
  const results = (data.summaries ?? [])
    // モデルが id を作り変えてくることがあるので、入力に無いものは捨てる。
    .filter((s) => known.has(s.id))
    .map((s) => ({
      id: s.id,
      // 長い見出しは一覧でも Markdown でも扱いにくいので切る。
      // 返らなかったときは空にして、呼び出し側で原題に戻せるようにする。
      title_ja: String(s.title_ja ?? '').trim().slice(0, 120),
      bullets: (s.bullets ?? []).slice(0, 4).map((b) => String(b).trim()).filter(Boolean),
      tags: (s.tags ?? []).slice(0, 6).map((t) => String(t).trim()).filter(Boolean),
    }));

  return { results, model: SUMMARY_MODEL, usage };
}
