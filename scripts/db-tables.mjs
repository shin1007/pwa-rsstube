/**
 * バックアップ・復元で扱うテーブルと、その順序。
 *
 * 外部キーの向きに沿って並べてある。復元はこの順、削除するならこの逆順。
 *
 * **テーブルを足したらここにも足すこと。** 忘れても誰も気づかない。
 * 実際、0005 で購読を subscriptions に切り出したときに入れ忘れていて、
 * 「購読一覧は作り直しが効かないから取っておく」と書いてあるファイルが
 * その購読一覧を取っていなかった（復元してもフィードだけあって購読ゼロになる）。
 *
 * 入っていないもの:
 *   jobs                 巡回のたびに作られる一時的なキュー。戻すと古い仕事が動き出す
 *   webauthn_challenges  数分で期限切れになる乱数。戻す意味が無い（0034）
 *   schema_migrations    db:migrate が管理する
 *   google_accounts      リフレッシュトークン。**平文のJSONに書き出したくない**
 *   app_config           Google のクライアントシークレット。同上（0033）
 *   ai_keys              ユーザーごとの Gemini API キー。同上（0046）
 *
 * 後ろ3つは秘密そのものなので、意図して外してある。失うと繋ぎ直し（app_config は
 * Google Cloud Console から、ai_keys は Google AI Studio から取り直して設定画面へ入れ直す）になるが、
 * backups/ に平文で置くほうが割に合わない。**この判断ごと消さないこと。**
 *
 * 音声の実体（Supabase Storage の mp3）はここでは取れない。media / media_segments は
 * 行だけ戻るので、ファイルが失われていれば再生できない。作り直せるものなので、
 * 消えたら音声化し直す（記事と要約は残っているため台本から作れる）。
 */
export const TABLES = [
  'folders',
  'feeds',
  // 誰がどのフィードを購読しているか。これが無いと復元しても何も読めない。
  'subscriptions',
  'articles',
  'article_states',
  'summaries',
  'exports',
  'digests',
  // media は articles と digests を参照するので、その後ろ。
  'media',
  'media_segments',
  'settings',
  // 通知の登録先。端末で登録し直せるが、戻せるなら戻したほうが早い。
  'push_subscriptions',
  // パスキー。中身は**公開**鍵なので、平文で置いても秘密は漏れない
  // （google_accounts を外している理由はこちらには当てはまらない）。
  // 失うと端末ごとに登録し直しになる。
  'passkeys',
  // 使用量の記録。消えると無料枠の消費ペースの履歴が失われる。
  'ai_usage',
];
