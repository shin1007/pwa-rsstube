-- DB を 300MB 未満に保つ（2026-11-10）。
--
-- 実測で 901MB あった（無料枠は 500MB）。内訳:
--   PGroonga の索引ファイル  約690MB  ← pg_relation_size に出てこない（別ファイル）
--   articles の TOAST（本文）   116MB
--   cron.job_run_details         43MB  ← 8万9千行、8月から一度も消していない
-- PGroonga は古い索引ファイルを VACUUM まで残す。autovacuum は dead tuple が
-- 閾値を超えないと来ないので、手で VACUUM しただけで 901MB → 571MB に落ちた。
--
-- 本文が消えていなかった理由: purge_article_bodies() は article_states の行が
-- ある記事しか見ていなかった。未読は行が無いので、**一度も開かなかった記事の
-- 本文は永久に残る**（本文のある 10894 件のうち 3984 件が行なし）。
--
-- 直し方は3つ:
--   1. 保持期間を過ぎたら、未読でも本文を落とす（スター・書き出し済みは残す）
--   2. それでも本文の合計が上限を超えるなら、古いほうから落とす（容量の上限）
--   3. 毎日 VACUUM して PGroonga のゴミを捨てる・cron の履歴を7日で切る

create or replace function purge_article_bodies(
  -- 残す本文（content_text + content_html + rss_html、圧縮後）の合計の上限。
  -- 30MB で DB 全体がおよそ 250MB（PGroonga の索引が本文テキストの約5倍に膨らむ）。
  p_max_body_bytes bigint default 30 * 1024 * 1024
)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  purged int;
  capped int;
begin
  -- 1. 保持期間。購読者の誰かがスター・書き出し・「消さない（0）」なら残す。
  --    article_states の行が無い（＝誰も開いていない）記事も対象にする。
  update articles a
     set content_text = null,
         content_html = null,
         rss_html     = null,
         content_ok   = false
   where (a.content_text is not null or a.content_html is not null or a.rss_html is not null)
     and a.created_at < now() - make_interval(days => 7)
     and not exists (
       select 1 from article_states s
        where s.article_id = a.id
          and (s.is_starred or s.exported_at is not null)
     )
     and not exists (
       select 1 from subscriptions sub
         left join settings t on t.user_id = sub.user_id
        where sub.feed_id = a.feed_id
          and (coalesce(t.retention_days, 90) = 0
               or a.created_at >= now() - make_interval(days => coalesce(t.retention_days, 90)))
     );
  get diagnostics purged = row_count;

  -- 2. 容量の上限。新しい順に足していき、上限を超えたぶんを落とす。
  --    「消さない（0）」の設定もここでは効かない——上限は全員で共有している枠のため。
  --    スター・書き出し済みは残す（数が少なく、消すと二度と読めない）。
  update articles a
     set content_text = null,
         content_html = null,
         rss_html     = null,
         content_ok   = false
    from (
      select id
        from (
          select x.id,
                 sum(coalesce(pg_column_size(x.content_text), 0)
                   + coalesce(pg_column_size(x.content_html), 0)
                   + coalesce(pg_column_size(x.rss_html), 0))
                   over (order by x.created_at desc, x.id) as running
            from articles x
           where (x.content_text is not null or x.content_html is not null or x.rss_html is not null)
             and not exists (
               select 1 from article_states s
                where s.article_id = x.id
                  and (s.is_starred or s.exported_at is not null)
             )
        ) r
       where r.running > p_max_body_bytes
    ) over_cap
   where a.id = over_cap.id;
  get diagnostics capped = row_count;

  return purged + capped;
end
$$;

comment on function purge_article_bodies(bigint) is
  '保持期間を過ぎた記事と、本文の合計が上限を超えたぶんの本文を落とす（スター・書き出し済みは残す）。pg_cron から毎日呼ぶ。';

-- 古い引数なしの版は残さない（同名で2つあると cron の呼び出しが曖昧になる）。
drop function if exists purge_article_bodies();

-- 3. 毎日の掃除。URL も秘密も要らないので、scheduler.sql ではなくここで登録する。
do $$
begin
  perform cron.unschedule(jobname) from cron.job
   where jobname in ('rsstube-vacuum', 'rsstube-cron-history');

  -- rsstube-purge（3:30）で本文を落としたあとに。VACUUM は1文だけで流すこと
  -- （複数文だとトランザクションに包まれて失敗する）。
  perform cron.schedule('rsstube-vacuum', '40 3 * * *', 'vacuum articles');

  perform cron.schedule('rsstube-cron-history', '35 3 * * *',
    $q$delete from cron.job_run_details where end_time < now() - interval '7 days'$q$);
end
$$;
