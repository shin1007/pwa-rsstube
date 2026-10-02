/**
 * 出力の言語。
 *
 * 記事は何語で書かれていても、**読む側の言語は1つ**でいい。要約・見出し・
 * 音声の台本はすべてここで決めた言語で作る。
 *
 * 言語はユーザーごと（settings.summary_language）。記事は全員共通だが、
 * 要約は `(article_id, language)` で持ち、同じ言語で読む人どうしで共有する（0047）。
 */

export const LANGUAGES = {
  ja: { label: '日本語', inPrompt: '日本語' },
  en: { label: 'English', inPrompt: 'English' },
  'zh-CN': { label: '中文（简体）', inPrompt: '简体中文' },
  'zh-TW': { label: '中文（繁體）', inPrompt: '繁體中文' },
  ko: { label: '한국어', inPrompt: '한국어' },
  es: { label: 'Español', inPrompt: 'español' },
  fr: { label: 'Français', inPrompt: 'français' },
  de: { label: 'Deutsch', inPrompt: 'Deutsch' },
  pt: { label: 'Português', inPrompt: 'português' },
} as const;

export type LanguageCode = keyof typeof LANGUAGES;

export const DEFAULT_LANGUAGE: LanguageCode = 'ja';

/** 設定に入っている値が使えるものか確かめる。知らない値は既定に倒す。 */
export function normalizeLanguage(value: unknown): LanguageCode {
  return typeof value === 'string' && value in LANGUAGES
    ? (value as LanguageCode)
    : DEFAULT_LANGUAGE;
}

/**
 * プロンプトに埋める言語名。
 *
 * コード（`ja`）をそのまま渡すと、モデルが「ja で書け」と読んで揺れる。
 * その言語自身の呼び名（`日本語`・`简体中文`）で頼むほうが素直に従う。
 */
export function languageName(code: string): string {
  return LANGUAGES[normalizeLanguage(code)].inPrompt;
}

/** 画面に出す名前。 */
export function languageLabel(code: string): string {
  return LANGUAGES[normalizeLanguage(code)].label;
}
