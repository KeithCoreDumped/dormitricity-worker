-- 关闭外键检查，避免清空顺序导致约束错误
PRAGMA foreign_keys = OFF;

-- 清空业务表
DELETE FROM subscriptions;
DELETE FROM users;

DELETE FROM crawl_failures;
DELETE FROM dorm_latest;
DELETE FROM readings;
DELETE FROM crawl_slices;
DELETE FROM crawl_jobs;
DELETE FROM crawl_targets;

-- 清理自增序列（如果表有 AUTOINCREMENT 主键）
DELETE FROM sqlite_sequence WHERE name IN (
  'subscriptions',
  'users',
  'crawl_failures',
  'readings',
  'crawl_slices',
  'crawl_jobs',
  'crawl_targets'
);

-- 重新开启外键检查
PRAGMA foreign_keys = ON;

-- npx wrangler d1 execute dormdb --remote --file=./sql/reset.sql