import { oneSummary } from '@/lib/summaries';
import { currentUser } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

/**
 * 圏外で読むぶんを、1本の JSON にまとめて渡す。
 *
 * **なぜ「ページを丸ごとキャッシュする」形にしないか。** 記事のページは
 * `/?view=all&article=<id>` で、中身は一覧＋サイドバー＋本文の全部入り
 * （実測 140〜370KB）。20件ぶん取れば数メガになるうえ、同じ一覧を20回
 * 持つことになる。**要るのは本文だけ**なので、データだけを渡して、
 * 描くのは `public/offline.html`（外部ファイルを一切参照しない1枚）に任せる。
 *
 * 呼ぶのは `components/OfflineCache.tsx`。取ったものは Cache Storage に置き、
 * 圏外で画面遷移が失敗したときにサービスワーカーが出す offline.html が読む。
 *
 * **持ち出すのは自分が読めるものだけ。** ここは RLS の効くクライアントで引くので、
 * `article_states` の内部結合がそのまま「自分の購読ぶん」の切り出しになる（0005）。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 持ち出す件数。回線と保存容量の折り合い。通勤1回ぶんはこれで足りる。 */
const LIMIT = 20;

/** 1件あたりの本文の上限。議事録のような長いものだけを切る（切ったことは印を付ける）。 */
const MAX_CHARS = 60_000;

/**
 * まとめて持ち出す量の上限。
 *
 * **回線を細いものとして扱う。** 通勤前の1回で落とすものなので、
 * 記事が偶然どれも長い日に何メガも落とさせない。超えたぶんは本文を外して、
 * 見出しと要点だけを持たせる（一覧には出るので、圏外でも「何が来ているか」は分かる）。
 */
const MAX_TOTAL_CHARS = 400_000;

/**
 * 画像・動画の類は落とす。
 *
 * **圏外では中身が取れないので、置いても「壊れた枠」が並ぶだけ。** 消せば
 * 持ち出す量も減る（実測で本文の平均 26KB → 5KB 前後）。消したことは
 * offline.html 側に書いてあるので、写真が要る記事はオンラインで開き直せばよい。
 *
 * 中身は保存する前に消毒済み（lib/feeds/sanitize.ts）で、通っているタグは
 * こちらが決めた分だけなので、ここは素直に取り除くだけでよい。
 */
function stripMedia(html: string): string {
  return html
    .replace(/<(img|source|track)\b[^>]*\/?>/gi, '')
    .replace(/<(video|audio|iframe|picture|figure)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(video|audio|iframe|picture|figure)\b[^>]*\/?>/gi, '');
}

export async function GET() {
  const supabase = await createClient();

  const user = await currentUser(supabase);
  if (!user) return new Response('unauthorized', { status: 401 });

  const { data, error } = await supabase
    .from('articles')
    .select(
      `id, title, url, published_at, content_html, content_text, content_ok, extract_fail,
       feeds!inner (title),
       summaries (bullets, title_ja),
       article_states!inner (is_read)`,
    )
    // 圏外で読みたいのは「これから読むもの」。未読を新しい順に。
    .eq('article_states.is_read', false)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(LIMIT);

  if (error) return new Response(error.message, { status: 502 });

  type Row = {
    id: string;
    title: string;
    url: string;
    published_at: string | null;
    content_html: string | null;
    content_text: string | null;
    content_ok: boolean;
    extract_fail: string | null;
    feeds: { title: string } | null;
    // 言語ごとに持つので配列で返る（0047）。RLS が自分の言語だけに絞っている。
    summaries: { bullets: string[]; title_ja: string | null }[] | null;
  };

  let budget = MAX_TOTAL_CHARS;

  const articles = ((data ?? []) as unknown as Row[]).map((r) => {
    const summary = oneSummary(r.summaries);
    const full = r.content_html ? stripMedia(r.content_html) : (r.content_text ?? '');
    // 上限に当たったら、そこから先は本文を持たない（見出しと要点だけ残す）。
    const room = Math.min(MAX_CHARS, budget);
    const body = full.slice(0, room);
    budget -= body.length;

    return {
      id: r.id,
      title: summary?.title_ja?.trim() || r.title,
      url: r.url,
      feed: r.feeds?.title ?? null,
      published_at: r.published_at,
      bullets: summary?.bullets?.slice(0, 3) ?? [],
      /** 本文。HTML があればそちら、無ければ素のテキスト。どちらも無ければ null。 */
      html: r.content_html && body ? body : null,
      text: !r.content_html && body ? body : null,
      /** 途中で切ったか。切ったことを黙っていると、記事が尻切れに見える。 */
      truncated: body.length < full.length,
      /** 取れていない記事は、圏外でも「取れていない」と分かるようにしておく。 */
      partial: !r.content_ok,
    };
  });

  return Response.json(
    { at: new Date().toISOString(), articles },
    {
      headers: {
        // 手元に置くのはこちら（Cache Storage）なので、HTTP のキャッシュは要らない。
        'cache-control': 'no-store',
      },
    },
  );
}
