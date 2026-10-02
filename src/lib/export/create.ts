import { oneSummary, summaryLanguageOf } from '@/lib/summaries';
import { JST } from '@/lib/datetime';
import { buildMarkdown, type ExportArticle } from '@/lib/export/markdown';
import { DEFAULT_NOTEBOOKLM_PROMPT } from '@/lib/export/prompt';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 記事を NotebookLM 用の Markdown にまとめて `exports` に保存する。
 *
 * ここに切り出してあるのは、同じ処理を2つの入口から呼ぶため:
 *   - 画面の「NotebookLM へ」（ログインセッションのクライアント）
 *   - 毎朝ダイジェストの cron（Secret キーのクライアント。auth.uid() が無い）
 * どちらも「まとめ方」は同じでなければ困る（朝の音声と手動書き出しで
 * 中身の形が違うと、NotebookLM 側の指示文が効かなくなる）。
 *
 * 記事は全ユーザー共通だが、書き出しと既読状態は個人のものなので userId を必ず取る。
 */

type Raw = {
  id: string;
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  content_text: string | null;
  content_ok: boolean;
  feeds: { title: string } | null;
  summaries: { bullets: string[]; title_ja: string | null }[] | null;
};

export type ExportResult = {
  id: string;
  title: string;
  markdown: string;
  prompt: string;
};

export async function createExportFor(
  db: SupabaseClient,
  userId: string,
  articleIds: string[],
  kind: 'manual' | 'digest' = 'manual',
  title?: string,
): Promise<ExportResult> {
  if (articleIds.length === 0) throw new Error('記事が選択されていません');

  // ダイジェストは Secret キーで呼ばれるので RLS が言語を絞らない。必ず指定する（0047）。
  const language = await summaryLanguageOf(db, userId);

  const { data, error } = await db
    .from('articles')
    .select(
      `id, title, url, author, published_at, content_text, content_ok,
       feeds (title), summaries (bullets, title_ja)`,
    )
    .in('id', articleIds)
    .eq('summaries.language', language);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Raw[];
  if (rows.length === 0) throw new Error('記事が見つかりません');

  // 渡された順を保つ（一覧で見ていた並び・ダイジェストの選抜順のまま音声になる）。
  const order = new Map(articleIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const articles: ExportArticle[] = rows.map((r) => ({
    title: r.title,
    url: r.url,
    feedTitle: r.feeds?.title ?? null,
    author: r.author,
    publishedAt: r.published_at,
    bullets: oneSummary(r.summaries)?.bullets ?? null,
    titleJa: oneSummary(r.summaries)?.title_ja ?? null,
    contentText: r.content_text,
    contentOk: r.content_ok,
  }));

  const finalTitle =
    title ??
    (rows.length === 1
      ? rows[0].title
      : `RSSTube ${new Date().toLocaleDateString('ja-JP', { timeZone: JST })}`);

  const markdown = buildMarkdown(articles, finalTitle);

  const { data: settings } = await db
    .from('settings')
    .select('notebooklm_prompt')
    .eq('user_id', userId)
    .maybeSingle();

  // 設定を一度も保存していないと settings の行が無い。既定の指示文で埋めておく
  // （空のまま NotebookLM に渡すと、ただの読み上げになってしまう）。
  const prompt = settings?.notebooklm_prompt?.trim() || DEFAULT_NOTEBOOKLM_PROMPT;

  const { data: saved, error: saveError } = await db
    .from('exports')
    .insert({
      user_id: userId,
      kind,
      title: finalTitle,
      markdown,
      prompt,
      article_ids: rows.map((r) => r.id),
    })
    .select('id')
    .single();
  if (saveError) throw saveError;

  // 送信済みの印を付けて、次回まとめて出すときに重複しないようにする。
  // 状態行は (article_id, user_id) が主キー（0005）。article_id だけで
  // onConflict を指定すると他人の行に当たって弾かれる。
  const now = new Date().toISOString();
  const { error: stateError } = await db.from('article_states').upsert(
    rows.map((r) => ({
      article_id: r.id,
      user_id: userId,
      exported_at: now,
      updated_at: now,
    })),
    { onConflict: 'article_id,user_id' },
  );
  if (stateError) throw stateError;

  return { id: saved.id, title: finalTitle, markdown, prompt };
}
