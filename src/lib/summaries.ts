import { normalizeLanguage, type LanguageCode } from '@/lib/language';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 要約は言語ごとに持つ（0047）。主キーが (article_id, language) になったので、
 * PostgREST の埋め込み `summaries (…)` は**1件でも配列で返る**（一対多になるため）。
 * 型には `| null` と書いてあるので型検査では気づけない（article_states と同じ罠）。
 * 読んだところで必ずこれを通して1件に均すこと。
 *
 * ログイン中のクライアントなら RLS が自分の言語だけに絞る。Secret キーの
 * クライアントは絞られないので、`.eq('summaries.language', …)` を必ず添える。
 */
export function oneSummary<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** その人が読む言語。行が無ければ既定（列の既定と同じ）。 */
export async function summaryLanguageOf(db: SupabaseClient, userId: string): Promise<LanguageCode> {
  const { data } = await db
    .from('settings')
    .select('summary_language')
    .eq('user_id', userId)
    .maybeSingle();
  return normalizeLanguage(data?.summary_language);
}

/** 言語を替えたときに、作り直しを積む記事の数。一覧の1ページぶん。 */
export const RESUMMARIZE_ON_LANGUAGE_CHANGE = 60;

/**
 * 言語を替えた人のために、新しい順に要約を積む。
 *
 * 新しい言語の要約はまだ無いので、積まないと一覧は24時間ぶん空になる
 * （0047 の「要約待ちは隠す」）。**全記事は浚わない**（docs/traps/jobs.md
 * 「後から全記事を浚う処理を足さない」）——古いものは要約なしで一覧に出ていて、
 * 欲しければ開いて「AI要約を生成する」を押せる。
 *
 * @param supabase ログイン中のクライアント（自分の記事と、自分の言語の要約だけが見える）
 * @param admin    ジョブを積む Secret キーのクライアント（jobs にはポリシーが無い）
 * @returns 積んだ件数
 */
export async function queueRecentSummaries(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  language: LanguageCode,
): Promise<number> {
  const { data, error } = await supabase
    .from('articles')
    .select('id, summaries (article_id), article_states!inner (user_id)')
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(RESUMMARIZE_ON_LANGUAGE_CHANGE);
  if (error) throw error;

  const targets = ((data ?? []) as unknown as { id: string; summaries: unknown }[])
    .filter((r) => !oneSummary(r.summaries as { article_id: string }[] | null))
    .map((r) => r.id);

  // 1件ずつ積む。まとめて insert すると、既に積まれている1件の 23505 で全部が落ちる。
  await Promise.all(
    targets.map(async (id) => {
      const { error } = await admin
        .from('jobs')
        .insert({ user_id: null, type: 'summarize', payload: { article_id: id, language } });
      if (error && error.code !== '23505') throw error;
    }),
  );
  return targets.length;
}
