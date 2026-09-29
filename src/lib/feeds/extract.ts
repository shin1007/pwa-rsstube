import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { htmlToText as buildText } from '@/lib/feeds/text';
import { decodeBody } from '@/lib/feeds/charset';
import { sanitizeHtml } from '@/lib/feeds/sanitize';
import { pickImageFromDocument } from '@/lib/feeds/image';
import { pickFollowups, type Followup } from '@/lib/feeds/followup';
import { looksLikeFrame, mainRegionHtml } from '@/lib/feeds/frame';
import { fetchPdfText, pdfTextToParagraphs, readPdf } from '@/lib/feeds/pdf';

/**
 * 記事本文の抽出。
 *
 * RSS には抜粋しか入っていないことが多く、抜粋だけを要約させても
 * 「抜粋の言い換え」にしかならない。記事URLを取りに行って本文を抜く。
 * サイトによっては取れない（JS描画・ペイウォール・403）ので、
 * 失敗は想定内として扱い、呼び出し側でRSSの内容にフォールバックする。
 *
 * DOM は jsdom ではなく linkedom を使う。jsdom@30 が引く html-encoding-sniffer は
 * CJS のまま ESM 専用の @exodus/bytes を require() していて、Vercel が jsdom を
 * 外部モジュールとして読み込む経路で ERR_REQUIRE_ESM になる。ローカルの dev では
 * ESM で解決されるので再現せず、本番で初めてワーカーが丸ごと落ちた。
 * linkedom は依存も軽く、サーバーレスのコールドスタートにも効く。
 * 差し替え時に実記事8件で比較し、抽出結果が完全に一致することを確認済み。
 */

export type ExtractResult = {
  text: string;
  /**
   * 消毒済みの本文HTML。画面に出すのはこちら（lib/feeds/sanitize.ts）。
   * 要約と検索はテキストのほうを使う（マークアップは AI に何も足さない）。
   */
  html: string;
  /** true = 本文抽出に成功。false = 取れなかった。 */
  ok: boolean;
  /**
   * 記事の代表画像（og:image）。スライドの表紙に使う。
   * 本文が短すぎて ok=false のときも、絵だけは使えるので返す。
   */
  imageUrl: string | null;
  /**
   * 本文をどこから取ったか。記事URLのHTMLそのものなら空。
   * PDFや別ページを本体として読んだときだけ入る（lib/feeds/followup.ts）。
   * 画面には「本体はこれ」の1行として出し、`check:url` にも出す。
   */
  sources?: Followup[];
};

const USER_AGENT =
  'Mozilla/5.0 (compatible; RSSTube/0.1; personal feed reader)';

/** 要約に渡す上限。長すぎる記事は先頭を優先して切る。 */
const MAX_CHARS = 40_000;

/**
 * 保存するHTMLの上限。タグのぶんテキストより嵩むので広めに取るが、
 * 無制限にすると DB（無料枠500MB）を一気に食う。
 */
const MAX_HTML_CHARS = 120_000;

/**
 * これ未満なら「本文を取れなかった」とみなす境目。
 *
 * 短い記事は実在する。アメブロのように、動画を紹介するだけの300字程度の投稿は
 * 珍しくない。一方で、ここを下げすぎると本文でないものを本文として拾う。
 *
 * 実データ（抽出に失敗している44件）で100〜200字の帯を調べたところ、中身は
 * はっきり2種類に割れた:
 *
 *   東洋経済など  写真キャプション＋著者プロフィール（ペイウォールで本文が出ない）。
 *                 RSS の抜粋のほうが本物のリード文で、明らかに良い
 *   Hacker News   ナビゲーションや変更履歴。ただし RSS 抜粋が
 *                 `<a href=…>Comments</a>` だけなので、これでもマシ
 *
 * つまりこの帯は当たり外れが混ざる。200 のままだと短い実記事を捨て、100 にすると
 * キャプションを拾う。**短い記事を拾えるほうを選んで 100 にしている**（本人の判断）。
 *
 * 要約の質が落ちたと感じたら、まずここを 200 に戻して様子を見ること。
 * どの記事が影響を受けているかは `npm run check:url -- <URL>` で確かめられる。
 */
const MIN_CONTENT_CHARS = 100;

/**
 * ここを下回ったら「本体は別にあるのでは」と疑う境目。
 *
 * **`MIN_CONTENT_CHARS` では足りない。**入口だけのページでは Readability が
 * 掴むものが無く、代わりにフッターを本文として返してくる。実例（厚労省
 * `shika_iryou_doukou_r07.html`）で返ってきたのは
 * 「〒100-8916 東京都千代田区霞が関1-2-2 …Copyright ©…」の118字で、
 * **100字を超えているので「抽出成功」に見えていた**。取得失敗として数えられも
 * しないので、`feed_content_stats()` にも出てこない。
 *
 * 疑うだけなら安い（リンクを見るのはメモリの中だけ）。実際に取りに行くのは
 * followup.ts が「本体らしい」と認めたリンクがあるときだけなので、
 * 本文がちゃんとあるページには一切効かない。
 */
const FOLLOW_BELOW_CHARS = 600;

/** 本体を辿るのに使ってよい時間。ワーカーの maxDuration=60 を1本で食わない。 */
const FOLLOW_BUDGET_MS = 25_000;

export async function extractArticle(url: string): Promise<ExtractResult> {
  const res = await fetch(url, {
    // PDF も受け取る。記事URLがそのままPDFを指しているフィードがある
    // （自治体の「お知らせ」など）。以前はここで「HTMLではない」と投げていた。
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9',
    },
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const contentType = res.headers.get('content-type') ?? '';
  const body = new Uint8Array(await res.arrayBuffer());

  // 記事そのものがPDFのとき。HTMLの皮が無いので、そのまま読む。
  if (contentType.includes('pdf') || isPdfBytes(body)) {
    const pdf = await readPdf(body);
    if (!pdf) return { text: '', html: '', ok: false, imageUrl: null };
    return fromPdfText(pdf.text, null, []);
  }

  if (!contentType.includes('html')) {
    throw new Error(`HTMLではない (${contentType})`);
  }

  // res.text() は Content-Type の charset しか見ず、無ければ UTF-8 として読む。
  // 日本の自治体・省庁には Shift_JIS / EUC-JP が現役で残っていて、しかも
  // charset を meta にだけ書いていることがある。そのまま読むと丸ごと文字化けし、
  // **長さはあるので抽出は成功に見えたまま**、化けた文字列が要約に回る。
  const html = decodeBody(res.headers.get('content-type'), body);
  // linkedom は外部リソースを取りに行かないので、画像やスクリプトで遅くならない。
  const { document } = parseHTML(html);
  // main の中身は Readability に渡す前に控えておく（渡した document は書き換えられる）。
  const mainHtml = mainRegionHtml(document);
  const article = new Readability(document).parse();
  // Readability は meta を落とすので、掴む前の document から取る。
  const imageUrl = pickImageFromDocument(document, url);
  // 枠を丸ごと掴んでいたら main の中だけでやり直す（lib/feeds/frame.ts）。
  const content = regrabInMain(article?.content ?? '', mainHtml);

  // textContent ではなく、Readability が整えた HTML から段落を組み立てる。
  // textContent はブロックの境目に何も入れないので段落が全部つながり、代わりに
  // 元HTMLの改行だけが残る。結果、見た目が書き手のHTMLの書き方に左右される
  // （改行だらけのサイトと、改行が1つも無いサイトができる）。lib/feeds/text.ts 参照。
  const text = htmlToText(content);
  // 相対パスの画像やリンクを解決するため、記事のURLを渡す。
  const safeHtml = sanitizeHtml(content, url);

  /**
   * 薄いページは「入口で、本体は別にある」ことを疑う。
   *
   * 表題とPDFへのリンクしか無いページは、ここまでの手順では本文が取れない
   * ——か、もっと悪いことに**フッターを本文として掴んで成功に見える**。
   * 本体を見つけられたらそちらを本文にする（lib/feeds/followup.ts）。
   *
   * 掴んだぶんは捨てる。入口ページで取れているのはたいてい枠の文字で、
   * 残すと本文の先頭に住所と著作権表示が並ぶ。本当のリード文だった場合も、
   * 同じ内容は本体の側にほぼ必ず載っている。
   */
  if (text.length < FOLLOW_BELOW_CHARS) {
    const followed = await followToBody(document, url, article?.title ?? undefined, imageUrl, text.length);
    if (followed) return followed;
  }

  // 極端に短い結果は抽出失敗とみなし、RSS の抜粋に任せる
  // （同意画面・エラーページ・ナビゲーションを掴んでいることが多い）。
  if (text.length < MIN_CONTENT_CHARS) {
    return { text, html: '', ok: false, imageUrl };
  }

  return {
    text: text.slice(0, MAX_CHARS),
    html: safeHtml.slice(0, MAX_HTML_CHARS),
    ok: true,
    imageUrl,
  };
}

/**
 * 枠を掴んでいたら、`<main>` の中だけでもう一度掴ませる。
 *
 * 掴み直しはメモリの中だけで済む（取得は1本も増えない）。やり直しても何も取れなければ
 * **元のまま返す**——枠でも、空文字にするよりは判断の材料が残る。取れたものが短ければ、
 * このあとの followToBody と MIN_CONTENT_CHARS がいつもどおり拾う。
 */
function regrabInMain(content: string, mainHtml: string | null): string {
  if (!mainHtml || !looksLikeFrame(content)) return content;
  // linkedom は完全な文書の形を要求する（body だけ渡すと黙って空で返ってくる）。
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${mainHtml}</body></html>`);
  const scoped = new Readability(document).parse()?.content ?? '';
  return htmlToText(scoped).length > 0 ? scoped : content;
}

/**
 * 入口ページから本体（PDF・別ページ）へ1段だけ辿る。
 *
 * 辿る条件は followup.ts 側に寄せてある。ここがやるのは取得と組み立てだけ。
 * **どれも短ければ null を返す**——中途半端に拾うくらいなら、今までどおり
 * 「取れなかった」として RSS の抜粋に任せるほうが、あとで見分けがつく。
 */
async function followToBody(
  document: Parameters<typeof pickFollowups>[0],
  pageUrl: string,
  title: string | undefined,
  imageUrl: string | null,
  /** このページ自身から取れた文字数。増えないなら差し替える意味が無い。 */
  ownLength: number,
): Promise<ExtractResult | null> {
  const candidates = pickFollowups(document, pageUrl, title);
  if (candidates.length === 0) return null;

  /**
   * 差し替えてよいのは**明らかに中身が増えたとき**だけ。
   *
   * 漫画のページで「最新話から」を辿ったら、行った先も同じ194字の作品紹介だった。
   * 中身は増えないのに、記事を1本読むたびに余計な取得が1本増え、
   * しかも「本体はこちら」と嘘の案内が出る。増えないなら辿らなかったことにする。
   */
  const enough = (length: number) => length >= MIN_CONTENT_CHARS && length >= ownLength + 200;

  const used: Followup[] = [];
  const parts: string[] = [];
  const until = Date.now() + FOLLOW_BUDGET_MS;

  for (const candidate of candidates) {
    if (parts.join('').length >= MAX_CHARS) break;
    // 1本目で時間を使い切ったら、そこまでで組み立てる。ワーカーごと落として
    // ジョブを宙に浮かせるより、取れたぶんで先へ進めるほうがよい。
    if (Date.now() >= until) break;

    try {
      if (candidate.kind === 'pdf') {
        const pdf = await fetchPdfText(candidate.url);
        if (!pdf) continue;
        parts.push(pdf.text);
        used.push(candidate);
        continue;
      }

      // 別ページは複数ページに渡る場合も読み込む。次ページへのリンクがあれば辿る。
      const pages = await readMultiPageBody(candidate.url, until);
      if (!pages || !enough(pages.text.length)) continue;
      return {
        text: pages.text.slice(0, MAX_CHARS),
        html: (lead([candidate], '本文') + pages.html).slice(0, MAX_HTML_CHARS),
        ok: true,
        imageUrl: imageUrl ?? pages.imageUrl,
        sources: [candidate],
      };
    } catch {
      // 1本が転んでも次を試す。全部だめなら下で null になる。
      continue;
    }
  }

  if (parts.length === 0) return null;
  const combined = parts.join('\n\n');
  if (!enough(combined.length)) return null;
  return fromPdfText(combined, imageUrl, used);
}

/** 複数ページに渡る記事を読む。次ページへのリンクを見つけて辿る。 */
async function readMultiPageBody(
  url: string,
  until: number,
): Promise<{ text: string; html: string; imageUrl: string | null } | null> {
  const htmlParts: string[] = [];
  let imageUrl: string | null = null;
  let currentUrl = url;
  const visited = new Set<string>([normalize(url)]);

  while (htmlParts.join('').length < MAX_CHARS && Date.now() < until) {
    const res = await fetch(currentUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) break;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) break;

    const body = new Uint8Array(await res.arrayBuffer());
    const { document } = parseHTML(decodeBody(contentType, body));
    const article = new Readability(document).parse();

    if (!article?.content) break;

    const html = sanitizeHtml(article.content, currentUrl);
    htmlParts.push(html);

    if (!imageUrl) {
      imageUrl = pickImageFromDocument(document, currentUrl);
    }

    // 次のページへのリンクを見つける
    const nextUrl = findNextPageLink(document, currentUrl);
    if (!nextUrl || visited.has(normalize(nextUrl))) break;

    visited.add(normalize(nextUrl));
    currentUrl = nextUrl;
  }

  if (htmlParts.length === 0) return null;

  return {
    text: htmlToText(htmlParts.join('\n\n')),
    html: htmlParts.join('\n\n'),
    imageUrl,
  };
}

/**
 * 次のページへのリンクを見つける。
 *
 * 「続き」「次へ」「→」「next」「>」「2」などのパターンを探す。
 * ページングの最初のページから順に辿るため、相対的に次の要素を探す。
 */
function findNextPageLink(
  document: Parameters<typeof pickFollowups>[0],
  currentUrl: string,
): string | null {
  let base: URL;
  try {
    base = new URL(currentUrl);
  } catch {
    return null;
  }

  const patterns = [
    // 日本語のテキスト
    /続き|次|もっと|さらに|全文/,
    // 英語のテキスト
    /next|continue|more|read more|part \d+/i,
    // 矢印・記号
    /^[→>]$|^next$/i,
    // ページ番号（「1」「2」「3」など、現在より大きい数字）
    /^\d+$/,
  ];

  const candidates: { url: URL; text: string; score: number }[] = [];

  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;

    try {
      const url = new URL(href, currentUrl);
      // ドメインが変わってたら別サイト
      if (url.hostname !== base.hostname) continue;

      // 同じURLなら無限ループ
      if (normalize(url.toString()) === normalize(currentUrl)) continue;

      const text = (anchor.textContent ?? '').trim().toLowerCase();
      if (!text) continue;

      let score = 0;
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          score += 10;
          // より短い（シンプルな）テキストを優先
          score += Math.max(0, 20 - text.length);
        }
      }

      if (score > 0) {
        candidates.push({ url, text, score });
      }
    } catch {
      continue;
    }
  }

  // スコアが高い候補を返す。同点なら最初に見つかったもの
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url.toString();
}

/** URLを正規化して比較できるようにする。 */
function normalize(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.href.split('#')[0]; // フラグメントを削除
  } catch {
    return url;
  }
}

/** PDFの文字を記事の形にする。記事URLが直接PDFのときと、辿った先の両方から使う。 */
function fromPdfText(
  text: string,
  imageUrl: string | null,
  sources: Followup[],
): ExtractResult {
  if (text.length < MIN_CONTENT_CHARS) {
    return { text, html: '', ok: false, imageUrl };
  }

  // 段落はこちらで組み直す（PDFの改行は紙の行の終わりでしかない）。
  // 中身はただの文字なのでタグは出てこないが、念のため必ず逃がす。
  const body = pdfTextToParagraphs(text)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('');

  return {
    text: text.slice(0, MAX_CHARS),
    html: (lead(sources, 'PDF') + body).slice(0, MAX_HTML_CHARS),
    ok: true,
    imageUrl,
    sources,
  };
}

/**
 * 「本体はこれ」の1行。
 *
 * **要約に渡すテキストには入れない。** 取得の事情を混ぜると、モデルが
 * 記事の中身ではなくそちらを要約してくる（「本文が取得できず…」で30件が
 * 埋まった前科がある）。読む人にだけ見えればよいので、HTMLにだけ置く。
 */
function lead(sources: Followup[], kind: string): string {
  if (sources.length === 0) return '';
  const links = sources
    .map((s) => `<a href="${escapeHtml(s.url)}">${escapeHtml(s.label || s.url)}</a>`)
    .join('、');
  return `<p>このページの本体は別にあります（${kind}）: ${links}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Content-Type が当てにならないサーバー用。PDFは必ず %PDF- で始まる。 */
function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

/**
 * HTMLタグを落として素のテキストにする。RSS本文のフォールバック用。
 * 段落の作り方は本文抽出と共有する（片方だけ読みやすい、という差を作らない）。
 */
export function htmlToText(html: string): string {
  return buildText(html).slice(0, MAX_CHARS);
}
