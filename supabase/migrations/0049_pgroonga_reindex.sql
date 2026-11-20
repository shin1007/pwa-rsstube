-- PGroonga の索引を毎日作り直す（2026-11-20）。
--
-- 0048 で毎日 VACUUM するようにしたが、10日で 571MB → 827MB に戻っていた。
-- テーブルの合計は 188MB のままで、増えたのは PGroonga の索引ファイル。
-- 本文を落とす（update で null にする）たびに索引の中が断片化して、VACUUM では縮まない。
-- REINDEX → VACUUM で 827MB → 502MB（新しい索引は本文 35MB に対して約 310MB）。
-- REINDEX だけでは新旧のファイルが並んで逆に増えるので、必ず後に VACUUM を置くこと。

do $$
begin
  perform cron.unschedule(jobname) from cron.job
   where jobname in ('rsstube-reindex', 'rsstube-vacuum');

  -- 3:30 purge → 3:35 cron の履歴 → 3:38 REINDEX → 3:50 VACUUM（古い索引ファイルを捨てる）
  perform cron.schedule('rsstube-reindex', '38 3 * * *', $q$
    reindex index articles_title_pgroonga_idx;
    reindex index articles_title_ja_pgroonga_idx;
    reindex index articles_content_pgroonga_idx;
  $q$);
  perform cron.schedule('rsstube-vacuum', '50 3 * * *', 'vacuum articles');
end
$$;
