DELETE FROM crawl_targets;
DELETE FROM sqlite_sequence WHERE name='crawl_targets';

INSERT OR IGNORE INTO crawl_targets(hashed_dir,canonical_id,enabled) VALUES
    ('hashA','6-205',1),
    ('hashB','E-202',1),
    ('hashC','10-1223',1),
    ('hashD','5-1223',1);

-- npx wrangler d1 execute dormdb --remote --file=./sql/insert.sql
