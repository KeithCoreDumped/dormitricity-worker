CREATE TABLE IF NOT EXISTS crawl_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hashed_dir TEXT NOT NULL UNIQUE, -- HMAC(canonical_id)
  canonical_id TEXT NOT NULL,      -- e.g. 10-102
  enabled INTEGER DEFAULT 1,
  last_crawled_ts INTEGER DEFAULT 0
);

/*
npx wrangler d1 execute dormdb --remote --file=./sql/schema.sql
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
  UNIQUE(hashed_dir, ts), -- unique constraint, duplications would be ignored/error
  FOREIGN KEY (hashed_dir) REFERENCES crawl_targets(hashed_dir) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dorm_latest (
  hashed_dir TEXT PRIMARY KEY,
  last_ts INTEGER NOT NULL,
  last_kwh REAL NOT NULL,
  FOREIGN KEY (hashed_dir) REFERENCES crawl_targets(hashed_dir) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crawl_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  hashed_dir TEXT NOT NULL,
  reason TEXT NOT NULL,
  ts INTEGER NOT NULL,
  FOREIGN KEY (hashed_dir) REFERENCES crawl_targets(hashed_dir) ON DELETE CASCADE
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
  hashed_dir TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  email_alert INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  UNIQUE(user_id, hashed_dir),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (hashed_dir) REFERENCES crawl_targets(hashed_dir) ON DELETE CASCADE
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

-- /////////////// subscriptions 表添加 notify 列 /////////////////////
-- 新增通知通道和 token 列
ALTER TABLE subscriptions
  ADD COLUMN notify_channel TEXT NOT NULL
    DEFAULT 'none'
    CHECK (notify_channel IN ('none','wxwork','feishu','serverchan'));

ALTER TABLE subscriptions
  ADD COLUMN notify_token TEXT;

-- （可选）增加索引，加速常用查询
CREATE INDEX IF NOT EXISTS idx_subs_hdir     ON subscriptions(hashed_dir);
CREATE INDEX IF NOT EXISTS idx_subs_user     ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_user_chan ON subscriptions(user_id, notify_channel);

-- ////////////////// notify 规则表 //////////////////////////////
-- 一条规则一行；同一个 subscription 可以有 'low_kwh' 与 'deplete' 各一条
CREATE TABLE IF NOT EXISTS subscription_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,

  rule_type TEXT NOT NULL
    CHECK (rule_type IN ('low_kwh','deplete')),

  -- 规则参数（按类型使用；未用置 NULL）
  threshold_kwh REAL,       -- 低电量规则用
  within_hours REAL,        -- 耗尽规则用

  -- 冷却：>= 12h（43200s）
  cooldown_sec INTEGER NOT NULL DEFAULT 43200
    CHECK (cooldown_sec >= 43200),

  -- 去重/边沿状态
  last_alert_ts INTEGER,          -- 最近一次发送

  created_ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_ts INTEGER,

  UNIQUE(subscription_id, rule_type),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

-- 索引：按订阅查规则；按类型做统计/筛选
CREATE INDEX IF NOT EXISTS idx_alerts_sub  ON subscription_alerts(subscription_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON subscription_alerts(rule_type);

