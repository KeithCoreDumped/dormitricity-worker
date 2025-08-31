CREATE TABLE IF NOT EXISTS crawl_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hashed_dir TEXT NOT NULL UNIQUE, -- HMAC(canonical_id)
  canonical_id TEXT NOT NULL,      -- campus:bld:floor:room
  enabled INTEGER DEFAULT 1,
  last_crawled_ts INTEGER DEFAULT 0
);

/*
npx wrangler d1 execute dormdb --local --file=./insert.sql
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
  UNIQUE(hashed_dir, ts)
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
