CREATE TABLE IF NOT EXISTS crawl_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hashed_dir TEXT NOT NULL UNIQUE, -- HMAC(canonical_id)
  canonical_id TEXT NOT NULL,      -- e.g. 10-102
  enabled INTEGER DEFAULT 1,
  last_crawled_ts INTEGER DEFAULT 0
);

/*
npx wrangler d1 execute dormdb --remote --file=./schema.sql
*/

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_slices INTEGER NOT NULL,
  finished_slices INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crawl_slices (
  job_id TEXT NOT NULL,
  slice_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payload TEXT NOT NULL,                 -- { "hashed_dir": "hashA...", "canonical_id": "campus:1:2:301" }
  PRIMARY KEY (job_id, slice_index)
);

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hashed_dir TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kwh REAL NOT NULL,
  ok INTEGER DEFAULT 1,
  UNIQUE(hashed_dir, ts) -- unique constraint, duplications would be ignored/error
);

CREATE TABLE IF NOT EXISTS dorm_latest (
  hashed_dir TEXT PRIMARY KEY,
  last_ts INTEGER NOT NULL,
  last_kwh REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS crawl_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  hashed_dir TEXT NOT NULL,
  reason TEXT NOT NULL,
  ts INTEGER NOT NULL
);

-- 用户表（邮箱登录）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- uuid
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,               -- PBKDF2 派生
  created_ts INTEGER NOT NULL
);

-- 订阅表：一个用户可订阅多个宿舍，但最多 3 个（触发器限制）
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  hashed_dir TEXT NOT NULL,            -- 宿舍主键（HMAC(canonical_id)）
  canonical_id TEXT NOT NULL,          -- 明文宿舍号（你允许持有）
  email_alert INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  UNIQUE(user_id, hashed_dir),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- 触发器：限制同一用户最多 3 个订阅
CREATE TRIGGER IF NOT EXISTS trg_subs_max3
BEFORE INSERT ON subscriptions
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM subscriptions WHERE user_id = NEW.user_id) >= 3
    THEN RAISE(ABORT, 'MAX_SUBS_REACHED')
  END;
END;

-- 查询加速索引（建议）
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_hashed ON subscriptions(hashed_dir);
CREATE INDEX IF NOT EXISTS idx_targets_enabled ON crawl_targets(enabled);

