-- Gemini の API キーをユーザーごとに持つ（2026-10-02）。
--
-- それまで鍵は環境変数 `GEMINI_API_KEY` の1本だけで、誰が使っても
-- オーナーの無料枠から引かれていた。2人目以降はその人の鍵で動かす。
-- オーナーは今までどおり環境変数のまま動く（ここに入れればそちらが優先）。
--
-- 誰の鍵を使うか（lib/ai/keys.ts）:
--   - 台本・音声（ユーザーごとの出力）→ 作らせた本人の鍵
--   - 要約（記事は全員共通。0005）→ そのフィードの購読者の鍵。オーナーが
--     購読していればオーナーの鍵、いなければ鍵を持つ購読者のうち先に購読した人
--   - 誰も鍵を持っていなければ要約しない（summary_skipped_at を付ける）
--
-- **RLS のポリシーを1つも作らない**（google_accounts / app_config と同じ扱い）。
-- 鍵はログイン中のブラウザからも読めないようにして、設定済みかどうかと
-- 末尾4文字だけをサーバー側（Secret キー）で確かめて画面に返す。

create table if not exists ai_keys (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  gemini_api_key text not null,
  updated_at     timestamptz not null default now()
);

alter table ai_keys enable row level security;
-- ポリシーは作らない（上の理由）。
revoke all on table ai_keys from anon, authenticated;

comment on table ai_keys is
  'ユーザーごとの Gemini API キー。ポリシーを作っていないので Secret キーからしか触れない。';

-- ---------------------------------------------------------------- 使用量

-- 無料枠は鍵ごとに数えられるので、使用量も「誰の鍵で」を持つ。
-- 今までの行はすべてオーナーの鍵のもの。この時点のユーザーはオーナー1人だけで、
-- オーナーはいちばん最初に作られたユーザー（実データで確認済み）。
alter table ai_usage add column if not exists user_id uuid references auth.users (id) on delete cascade;
update ai_usage
   set user_id = (select id from auth.users order by created_at limit 1)
 where user_id is null;
alter table ai_usage alter column user_id set not null;
alter table ai_usage drop constraint if exists ai_usage_pkey;
alter table ai_usage add primary key (day, model, user_id);

-- 見えるのは自分の鍵のぶんだけ。他人の使用量は他人の無料枠の話。
drop policy if exists ai_usage_read on ai_usage;
create policy ai_usage_read on ai_usage for select to authenticated
  using (user_id = auth.uid());

-- 引数を足すと別の関数として並んでしまい、名前付きで呼ぶと「どちらか決められない」
-- で落ちる。先に古いほうを消す。
drop function if exists record_ai_usage(text, bigint, bigint, boolean);

/*
 * p_user を省いたときはオーナー（最初のユーザー）に付ける。
 * デプロイが終わるまでの数分、古いコードが4引数で呼んでくるため。
 */
create or replace function record_ai_usage(
  p_model  text,
  p_input  bigint,
  p_output bigint,
  p_ok     boolean,
  p_user   uuid default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into ai_usage (day, model, user_id, calls, failures, input_tokens, output_tokens)
  values (
    (now() at time zone 'Asia/Tokyo')::date,
    p_model,
    coalesce(p_user, (select id from auth.users order by created_at limit 1)),
    1,
    case when p_ok then 0 else 1 end,
    greatest(p_input, 0),
    greatest(p_output, 0)
  )
  on conflict (day, model, user_id) do update set
    calls         = ai_usage.calls         + 1,
    failures      = ai_usage.failures      + case when p_ok then 0 else 1 end,
    input_tokens  = ai_usage.input_tokens  + greatest(p_input, 0),
    output_tokens = ai_usage.output_tokens + greatest(p_output, 0);
$$;

revoke execute on function record_ai_usage(text, bigint, bigint, boolean, uuid) from anon, authenticated, public;

comment on function record_ai_usage(text, bigint, bigint, boolean, uuid) is
  'Gemini の呼び出しを日×モデル×鍵の持ち主で足し込む。失敗も1回として数え、failures にも入れる。';

-- ---------------------------------------------------------------- 要約しない記事

-- 鍵を持つ購読者が1人もいない記事は要約しない。0045 は「要約が付くまで一覧に
-- 出さない」なので、印が無いと**その記事は永久に一覧に出ない**（待っても付かない）。
-- 付かないと決まった記事には印を付けて、要約なしで一覧に出す。
alter table articles add column if not exists summary_skipped_at timestamptz;

comment on column articles.summary_skipped_at is
  '鍵を持つ購読者がいなくて要約を見送った時刻。これがあれば要約なしでも一覧に出す（0046）。';

-- 0045 と同じ。違うのは summary_skipped_at の条件だけ。
create or replace function list_articles(
  p_view       text    default 'unread',
  p_folder     uuid    default null,
  p_feed       uuid    default null,
  p_term       text    default null,
  p_limit      int     default 60,
  p_offset     int     default 0,
  p_with_count boolean default false,
  p_ids_only   boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  -- **語に当たる id は、先に・別に集めること（`as materialized`）。**
  --
  -- `&@` を下の where に直接書くと、計画は「新しい順に走りながら1行ずつ
  -- `&@` を当てて、60件たまったら止まる」に化ける。索引は使われず、本文を
  -- 1行ずつ読み直すので **215ms**（実測）——0040 で ilike をやめた理由と
  -- 同じ形が、書き方を変えただけで戻ってくる。先に集合にしておけば
  -- PGroonga の索引がそのまま効いて **3〜13ms**。
  --
  -- 語が無いときは `coalesce(p_term,'') <> ''` が定数の偽になり、計画には
  -- One-Time Filter だけが残る（この CTE は走らない）。
  with matched as materialized (
    select a.id
      from articles a
     where coalesce(p_term, '') <> ''
       and (a.title &@ p_term or a.title_ja &@ p_term or a.content_text &@ p_term)
  ),
  picked as (
    select a.id,
           a.published_at,
           -- 窓は LIMIT/OFFSET より先に計算されるので、これが絞り込み後の総数。
           case when p_with_count then count(*) over () else null end as total
      from articles a
      join article_states st on st.article_id = a.id
      left join summaries sm on sm.article_id = a.id
     where a.feed_id in (
             select s.feed_id
               from subscriptions s
              where p_folder is null or s.folder_id = p_folder
           )
       and (p_feed is null or a.feed_id = p_feed)
       -- 要約が済んでいるものだけ（「要約なし」ビューは除く）。
       -- 要約が付くのを待たない記事（誰も鍵を持っていない。上の印）は出す。
       and (p_view = 'unsummarized' or sm.article_id is not null or a.summary_skipped_at is not null)
       and (coalesce(p_term, '') = '' or a.id in (select m.id from matched m))
       and case coalesce(p_view, 'all')
             when 'unread'  then st.is_read = false
             when 'starred' then st.is_starred = true
             -- 要約が落ちたものを見つけるビュー。**まだ本文を取りに行っていない
             -- 記事は混ぜない**（要約が無くて当たり前で、待てば付く。0014）。
             when 'unsummarized' then sm.article_id is null and a.extracted_at is not null
             else true
           end
     -- **同着は id で決める。** 実データで243件が同じ日時を持っていて
     -- （45組・最大18件が同時刻）、決めないと継ぎ足しで重複・欠落する。
     order by a.published_at desc nulls last, a.id desc
     limit greatest(coalesce(p_limit, 0), 0)
     offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    -- **1件も無いときは 0。null にしないこと**——null は「数えていない」
    -- （継ぎ足しのとき）という別の意味を持っていて、「ここで終わり」と同じではない。
    'total', case when p_with_count
                  then coalesce((select max(total) from picked), 0)
                  else null end,
    'articles',
      case when p_ids_only then
        coalesce((
          select jsonb_agg(
                   jsonb_build_object('id', p.id, 'published_at', iso8601(p.published_at))
                   order by p.published_at desc nulls last, p.id desc
                 )
            from picked p
        ), '[]'::jsonb)
      else
        coalesce((
          select jsonb_agg(
                   jsonb_build_object(
                     'id', a.id,
                     'title', a.title,
                     -- 行には出さないが `v`（元記事を開く）が使う。**消さないこと。**
                     'url', a.url,
                     'published_at', iso8601(a.published_at),
                     -- **要点があるときは抜粋を運ばない。** 行に出るのは片方だけで、
                     -- 抜粋は1行あたりでいちばん重い列（日本語で150字ほど）。
                     'excerpt', case
                                  when jsonb_array_length(coalesce(sm.bullets, '[]'::jsonb)) > 0
                                  then null else a.excerpt
                                end,
                     'extracted_at', iso8601(a.extracted_at),
                     'created_at', iso8601(a.created_at),
                     'feed', case when f.id is null then null
                                  else jsonb_build_object('id', f.id, 'title', f.title) end,
                     'summary', case when sm.article_id is null then null
                                     else jsonb_build_object(
                                       -- 行に出るのは先頭3つだけ。4つ目から先は運ぶだけ無駄。
                                       'bullets',
                                       jsonb_path_query_array(coalesce(sm.bullets, '[]'::jsonb),
                                                              '$[0 to 2]'),
                                       'title_ja', sm.title_ja
                                     ) end,
                     'state', jsonb_build_object(
                       'is_read', st.is_read,
                       'is_starred', st.is_starred,
                       'exported_at', iso8601(st.exported_at)
                     )
                   )
                   order by a.published_at desc nulls last, a.id desc
                 )
            from picked p
            join articles a       on a.id = p.id
            join article_states st on st.article_id = p.id
            join feeds f          on f.id = a.feed_id
            left join summaries sm on sm.article_id = p.id
        ), '[]'::jsonb)
      end
  )
$$;

create or replace function unread_counts()
returns table (feed_id uuid, unread bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select a.feed_id, count(*)
    from articles a
    join article_states s on s.article_id = a.id
    left join summaries sm on sm.article_id = a.id
   where s.user_id = auth.uid()
     and s.is_read = false
     and (sm.article_id is not null or a.summary_skipped_at is not null)
   group by a.feed_id
$$;
