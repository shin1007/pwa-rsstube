-- 要約が済んでいない記事は、一覧に出さない（済んでから出す）。
--
-- 取り込み直後の記事は本文の抽出も要約もまだで、RSS の抜粋だけが出ていた。
-- 薄い抜粋のまま読み始めると、あとで要約が付いて中身が入れ替わる。
-- 待てば付くものなので、付くまで一覧に出さない（unread_counts も同じ条件）。
--
-- **例外は「要約なし」ビュー。** 要約が落ちた記事を見つけるための場所なので、
-- ここまで隠すと永久に見えなくなる。記事を直接開くのは今までどおり（一覧だけの話）。

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
       and (p_view = 'unsummarized' or sm.article_id is not null)
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
    join summaries sm on sm.article_id = a.id
   where s.user_id = auth.uid()
     and s.is_read = false
   group by a.feed_id
$$;
