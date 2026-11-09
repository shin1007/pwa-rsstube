# 踏んだ罠 — DB・Server Action・依存

Supabase · PostgREST · actions/ · 追加した依存 を触るときに読む。索引は `CLAUDE.md` にある。

**ここに書くのは「決まったこと」ではなく「実際に壊れた話」だけ。**
同じ壊れ方をもう一度させないための記録なので、直し方だけでなく
「どう見えたか（何が起きているように見えたか）」を残すこと。

- **バックアップにテーブルを足し忘れると誰も気づかない。** `scripts/db-tables.mjs` が
  一覧で、0005 で切り出した `subscriptions` が長らく漏れていた（復元しても購読ゼロ）。
  jsonb 列は JSON 文字列にしてから戻すこと。JS の配列のまま渡すと pg が
  Postgres の配列に直してしまい `invalid input syntax for type json` になる
  （`text[]` の列は配列のままで正しいので、値の形では区別できない。列の型を DB に聞く）。

- **日本語の全文検索は PGroonga（0015）。** `simple` 辞書の tsvector は空白で区切るだけで
  日本語の文が丸ごと1語になり、0001 で張ったまま一度も使えていなかった。PGroonga は
  Supabase で `create extension` できる。**索引を張るだけで既存の `ilike` が8.2倍速**に
  なる（PGroonga が `ilike` も肩代わりするため、クエリの書き換えは要らない）。
  `&@~` を使えばさらに25倍だが、PostgREST から演算子を呼べないので RPC が要る。
  trgm と simple の索引は落とした（プランナが選ばなくなったため）。

- **PostgREST の `.order(col, { referencedTable: X })` は親の行順を変えない。**
  埋め込んだ X 側の並びを変えるだけ。`articles` を主に `summaries` を埋め込んで
  重要度順にしていたつもりが、実際は published_at 順のままだった（`0007` で発覚）。
  並べ替えは必ず親テーブルの列で行うこと。当時は `articles.importance` という複製を
  置いて凌いだが、重要度ごと廃止したので複製も消えている（`0037`）。
  **罠自体は残る**——別の列で同じことをやれば同じように黙って無視される。

- **ローカルで動いても Vercel で落ちる依存がある。** `jsdom@30` が引く
  html-encoding-sniffer が CJS のまま ESM を require していて、dev では通るが
  Vercel の外部モジュール読み込みで `ERR_REQUIRE_ESM`。本文抽出は `linkedom` に変えた。
  依存を足したら本番でも1回叩いて確かめること。

- **`settings` の行が無いと列の既定値は効かない。** 設定画面を一度も保存していないと
  行そのものが無いので、`notebooklm_prompt` の default（0001 に書いてある文面）は
  出てこない。空文字のまま書き出すと、NotebookLM が素の読み上げになる。
  既定値は `lib/export/prompt.ts` に TS 側の定数としても置き、行が無いときはそちらを使う。
  文面を変えるときは 0001 の default と両方を揃えること。

- **`article_states` の upsert は `onConflict: 'article_id,user_id'`。** 0005 で
  主キーが (article_id, user_id) に変わったのに `article_id` だけを指定したままの
  箇所が残っていた（書き出しの送信済みマーク）。1人で使っている間は表に出ないが、
  2人目が同じ記事を書き出した瞬間に他人の行へ当たって弾かれる。

- **Server Action で throw したエラーの文面は、本番では表に出ない。** Next が
  digest に置き換えるので、クライアントに届くのは `Minified React error #441`
  （中身を伏せた Server Components のエラー）だけ。`throw new Error('記事が見つかりません')`
  のような**見せるつもりの文面は値として返す**こと。actions/ には throw のまま
  残っている箇所がまだある（feeds / exports / push / drive）。

- **Server Action の失敗は「押しても何も起きない」に化ける。** Next は投げられた
  エラーを digest に置き換えるので、本番で届くのは `Minified React error #441`
  だけ。`throw new Error('フィードを読めませんでした')` の文面は一度も表に出ない。
  設定の保存ボタンでは、成功しても画面が1ドットも変わらないため、**成功・失敗・
  未送信の3つが全部同じに見えていた**。
  - 見せたい文面は**値として返す**こと。`lib/actions/result.ts` の `attempt()` で
    包めば、中の `throw` をそのまま文面にできる（中の書き方は変えなくてよい）。
  - `attempt()` は `unstable_rethrow()` を通すこと。**`redirect()` と `notFound()` は
    throw で動く**ので、飲み込むと画面遷移が「失敗しました」という文字列に化ける。
  - 素の `<form action={サーバー関数}>` は失敗を出す場所が無い。`ActionForm` を使う。
  - 成功にも手応えを出す。変化が見えない操作（保存・受付）は、文言と時刻を出さないと
    押せたかどうか分からない。
- **supabase-js の問い合わせビルダーは thenable。`async` 関数から返さないこと。**
  返すと、その `await` が**問い合わせを実行してしまう**（返ってくるのは組み立て
  途中のビルダーではなく結果）。`.order()` が無いと型検査に言われて気づいたが、
  型が緩い書き方をしていたら、そのまま並べ替えの無い問い合わせが走っていた。
  非同期に要るもの（購読の id など）だけを先に取り、当てるのは同期でやる。

- **`head: true` の PostgREST エラーはメッセージが空。** 件数だけ数える形は本文を
  返さないので、失敗しても `{"message":""}` しか来ない。画面には
  `Error: {"message":""}` の500だけが出て、**どの問い合わせが落ちたのか手掛かりが
  無い**。実例は「要約なし」ビューで、条件の `.is('summaries', null)` に対して
  select 側に `summaries` を埋めていなかった（`column articles.summaries does not
  exist`）。件数の select は一覧の select と同じ埋め込みを持たせること。

- **URL から来る id は形を見てから使う。** `?article=` `?folder=` `?feed=` は URL に
  出ているので、古いブックマーク・打ち間違い・リンクの切り貼りで UUID でない値が
  普通に来る。素通しすると Postgres が 22P02 で落ち、**フォルダを1つ選び損ねた
  だけのはずが、一覧もサイドバーも出ない500になる**。`lib/types.ts` の `asId()`。
  そして**見つからなかったときに何を出すかまで決めること**——記事が無いのに
  「選んでいる」状態のままだと、スマホは一覧が `hidden` で真っ白になる。

- **日時だけでは順番が決まらない。** 実データで**243件が同じ `published_at`**を
  持っていた（45組・最大18件が同時刻。自治体や省庁は同じ時刻でまとめて出す）。
  同着の中の並びは実行計画次第なので、決めないと2つ壊れる——**無限スクロールで
  記事が重複・欠落する**（offset で継ぎ足すので、同着の組がページの境目をまたぐ）、
  **「次の記事」が戻ったり飛んだりする**（前後は毎回この並びから数え直す）。
  いま安定して見えるのは計画がたまたま同じだから。最後に `id` で決着させる。

- **検索は、こちらの都合の外で失敗する。** 検索語は URL のクエリに3回
  （title / title_ja / content_text）並べて PostgREST へ渡すので、**200字を
  超えると通らない**（400字あたりで接続が切れ、1200字で400）。さらに
  `'; drop table articles;--` のような並びは Supabase の手前の WAF に HTML の
  ブロックページを返され、supabase-js が解釈できずに落ちる（技術系のフィードを
  読むなら普通に打つ語）。語は100字で切り、**失敗しても一覧だけ空にする**
  ——ページごと落とすと検索欄を直す場所まで消える。0件と同じ文面にしないこと。

- **`article_states` の埋め込みは配列で返る。** 主キーが
  `(article_id, user_id)` の複合なので、PostgREST は記事から見て「多」の関係と
  判断する——RLS で自分の1行しか返らなくても、形は `[{…}]` のまま。
  受け取る側は `state?.is_read` と**物として**読んでいたので、**全部
  undefined になっていた**。型には `{…} | null` と書けてしまう（実体は
  `unknown` 経由で通る）ので、型検査でもテストでも捕まらない。
  出方は「一覧でスター・あとで・書き出し済みの印が出ない」「既読の行が
  未読と同じ見た目になる」「本文を出したときの『既読にする』が毎回
  未読から始まる」で、**どれも壊れているようには見えない**のがたちが悪い。
  0042 で一覧とアーカイブは SQL 側が物として組み立てるようにし、
  本文（`getArticle`）は受け取った直後に均している。
  埋め込みを新しく足したら、**返ってきた形を1回は目で見ること**。

- **`public` に作った表は、RLS を書かなければ anon キーだけで読み書きできる。**
  Supabase の Security Advisor が `rls_disabled_in_public` を出したのは
  `schema_migrations`（2026-09-09、`0044` で塞いだ）。**この表だけが
  `supabase/migrations/` ではなく `scripts/db-migrate.mjs` の
  `create table if not exists` で作られていた**——移行を管理する側の道具なので
  0001 に書けず、そのぶん「表を作ったら RLS」の手順から外れていた。
  `migrations/` を見比べるだけでは見つからない（18表すべて RLS 済みに見える）。
  **本番に何があるかは本番に聞くこと**:
  `select relname, relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace
   where nspname='public' and relkind='r'`。
  実害は記事の流出ではなく移行の記録のほう——行を消されれば次の `db:migrate` が
  0001 から流し直そうとして落ち、偽の version を入れられれば以後の移行が黙って飛ぶ。
  塞ぎ方は RLS を有効にする（ポリシーは置かない。所有者の postgres は迂回するので
  `db:migrate` はそのまま動く）だけでなく、**`revoke all ... from anon, authenticated`
  まで**やること。Supabase は public の表に既定で両ロールへ全権限を渡すので、
  権限を残したまま RLS だけ有効にすると「0行が返る」形で通ってしまう。
  取り上げてあれば 401 で止まる（確認: anon キーで `/rest/v1/<表>` を叩いて
  `42501 permission denied` が返ること）。

## PGroonga の索引は、VACUUM するまで古いファイルを捨てない（0048）

2026-11-10、DB が **901MB**（無料枠 500MB）あった。テーブルを全部足しても 209MB しかなく、
残りは **PGroonga の索引ファイル**（`pg_relation_size` には 0 bytes と出る。別ファイルのため）。
古い索引ファイルは VACUUM が来るまで残り、autovacuum は dead tuple が閾値を超えないと来ない。
`vacuum articles` だけで 901MB → 571MB。**REINDEX しただけでは逆に増える**（1167MB。新旧が並ぶ）。

同時に、`purge_article_bodies()` が `article_states` の行がある記事しか見ていなかった。
未読は行が無いので、**開かなかった記事の本文は永久に残っていた**（本文ありの37%）。
0048 で、保持期間を過ぎたら未読でも落とし、さらに本文の合計を 30MB で頭打ちにした。
毎日 3:40 に `rsstube-vacuum`、3:35 に cron の履歴（`cron.job_run_details`、43MB あった）を7日で切る。

大きさは `pg_database_size()` で見ること。テーブルごとの合計では PGroonga が見えない。
