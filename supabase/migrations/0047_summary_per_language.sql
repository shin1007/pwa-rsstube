-- 要約を言語ごとに持つ（2026-10-02）。
--
-- それまで summaries は article_id だけが主キーで、言語は全体で1つ（オーナーの
-- settings.summary_language）だった。ユーザーが増えて読む言語が分かれたので、
-- (article_id, language) で持つ。記事・本文は今までどおり全員共通で、要約だけが
-- 言語の数ぶんになる。同じ言語の購読者どうしでは1本を共有する。
--
-- **読む側は自分の言語しか見えない**（下の RLS）。list_articles など
-- security invoker の関数も、ログイン中のユーザーとして summaries を読むので、
-- `left join summaries` のままで自分の言語の1行だけが結合される。
-- Secret キー（ワーカー・ダイジェスト）は RLS を通らないので、**言語を必ず指定すること。**

-- 今ある要約はオーナーの言語で作ったもの。この時点の設定は ja しか無い（実データで確認済み）。
alter table summaries add column if not exists language text not null default 'ja';
alter table summaries alter column language drop default;
alter table summaries drop constraint if exists summaries_pkey;
alter table summaries add primary key (article_id, language);

comment on column summaries.language is
  '要約・見出しの言語（settings.summary_language の値）。読む側は RLS で自分の言語だけ見える（0047）。';

-- ログイン中のユーザーの言語。行が無ければ既定（0001 の列の既定と同じ ja）。
create or replace function my_summary_language()
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select summary_language from settings where user_id = auth.uid()),
    'ja'
  )
$$;

-- `(select …)` で包むのは、行ごとではなく問い合わせ1回につき1回だけ評価させるため。
drop policy if exists summaries_read on summaries;
create policy summaries_read on summaries for select to authenticated
  using (language = (select my_summary_language()));

-- ---------------------------------------------------------------- 検索用の見出し

-- articles.title_ja は検索用の複製（0024）。言語が複数になったので、
-- どの言語の見出しでも当たるように全部つないで持つ。画面には出していない。
create or replace function sync_article_title_ja()
returns trigger
language plpgsql
as $$
declare
  target uuid := case when tg_op = 'DELETE' then old.article_id else new.article_id end;
begin
  update articles
     set title_ja = (select string_agg(s.title_ja, ' ' order by s.language)
                       from summaries s
                      where s.article_id = target and s.title_ja is not null)
   where id = target;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- ---------------------------------------------------------------- ジョブ

-- 同じ記事の要約でも、言語が違えば別の仕事。extract には language が無いので '' になる。
drop index if exists jobs_pending_unique_idx;
create unique index jobs_pending_unique_idx
  on jobs (type, (payload ->> 'article_id'), (coalesce(payload ->> 'language', '')))
  where status in ('queued', 'running');

-- ---------------------------------------------------------------- 一覧に出す条件

-- 0046 の summary_skipped_at は記事に1つの印で、言語が分かれると意味を成さない
-- （日本語の要約はあるが英語の読み手は鍵を持っていない、が表せない）。列ごと落とす。
alter table articles drop column if exists summary_skipped_at;

-- 鍵を入れているか。ai_keys はポリシーが無く本人からも読めないので、
-- 有無だけを security definer で返す。
create or replace function i_use_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from ai_keys where user_id = auth.uid())
$$;

revoke execute on function i_use_ai() from anon, public;
grant execute on function i_use_ai() to authenticated;

/*
 * 要約待ちで一覧から隠すのは、次の3つが揃ったときだけ:
 *   - 自分の言語の要約がまだ無い
 *   - 自分が鍵を入れている（入れていなければ待っても付くとは限らない）
 *   - 取り込んで24時間以内（要約は5〜10分で付く。24時間付かないなら落ちている）
 *
 * 0045 は「付くまで出さない」だったが、それだと要約が落ちた記事・言語を
 * 変えたあとの古い記事・鍵の無い人の記事が、一覧から永久に消える。
 */

-- 0046 と同じ。違うのは要約待ちで隠す条件だけ（上の注記）。
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
       -- 要約待ちは隠す（「要約なし」ビューは除く。条件は上の注記）。
       and (p_view = 'unsummarized'
            or sm.article_id is not null
            or a.created_at < now() - interval '24 hours'
            or not (select i_use_ai()))
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
     and (sm.article_id is not null
          or a.created_at < now() - interval '24 hours'
          or not (select i_use_ai()))
   group by a.feed_id
$$;
