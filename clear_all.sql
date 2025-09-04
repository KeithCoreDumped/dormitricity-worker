DELETE FROM crawl_failures;
DELETE FROM sqlite_sequence WHERE name='crawl_failures';

DELETE FROM crawl_jobs;
DELETE FROM sqlite_sequence WHERE name='crawl_jobs';

DELETE FROM crawl_slices;
DELETE FROM sqlite_sequence WHERE name='crawl_slices';

DELETE FROM dorm_latest;
DELETE FROM sqlite_sequence WHERE name='dorm_latest';

DELETE FROM readings;
DELETE FROM sqlite_sequence WHERE name='readings';

-- npx wrangler d1 execute dormdb --remote --file=./clear_all.sql