import type { Target, SeriesPoint, SubscriptionRow } from "./types.js";

export async function fetchEnabledTargets(db: D1Database): Promise<Target[]> {
    const r = await db
        .prepare(
            "SELECT hashed_dir, canonical_id FROM crawl_targets WHERE enabled=1"
        )
        .all();
    return (r.results as any[]).map((x) => ({
        hashed_dir: x.hashed_dir,
        canonical_id: x.canonical_id,
    }));
}

export async function createJobWithSlices(
    db: D1Database,
    jobId: string,
    slices: Target[][]
) {
    const now = Math.floor(Date.now() / 1000);
    const batch = db.batch([
        db
            .prepare(
                "INSERT INTO crawl_jobs (id,created_ts,status,total_slices) VALUES (?1,?2,'PENDING',?3)"
            )
            .bind(jobId, now, slices.length),
        ...slices.map((arr, i) =>
            db
                .prepare(
                    "INSERT INTO crawl_slices (job_id,slice_index,status,payload) VALUES (?1,?2,'PENDING',?3)"
                )
                .bind(jobId, i, JSON.stringify(arr))
        ),
    ]);
    await batch;
}

export async function claimOneSlice(db: D1Database, jobId: string) {
    const sel = await db
        .prepare(
            "SELECT slice_index, payload FROM crawl_slices WHERE job_id=?1 AND status='PENDING' LIMIT 1"
        )
        .bind(jobId)
        .all();
    const row = (sel.results as any[])[0];
    if (!row) return null;

    const upd = await db
        .prepare(
            "UPDATE crawl_slices SET status='RUNNING' WHERE job_id=?1 AND slice_index=?2 AND status='PENDING'"
        )
        .bind(jobId, row.slice_index)
        .run();

    if (upd.meta.changes > 0) {
        // PENDING -> RUNNING
        await db
            .prepare(
                "UPDATE crawl_jobs SET status='RUNNING' WHERE id=?1 AND status='PENDING'"
            )
            .bind(jobId)
            .run();

        // targets: Array<{hashed_dir, canonical_id}>
        return {
            slice_index: row.slice_index,
            targets: JSON.parse(row.payload) as Target[],
        };
    }
    return null;
}

export async function ingestBatch(db: D1Database, body: any) {
    const readings = body.readings as {
        hashed_dir: string;
        ts: number;
        kwh: number;
        ok?: boolean;
    }[];
    const failures =
        (body.failures as { hashed_dir: string; reason: string }[]) || [];
    const jobId = body.job_id as string;
    const idx = body.slice_index as number;

    console.log(`ingestBatch: got readings of length ${readings.length}`);

    const stmts = [];
    for (const r of readings) {
        stmts.push(
            db
                .prepare(
                    "INSERT OR IGNORE INTO readings (hashed_dir, ts, kwh, ok) VALUES (?1,?2,?3,?4)"
                )
                .bind(r.hashed_dir, r.ts, r.kwh, r.ok ? 1 : 0)
        );
        stmts.push(
            db
                .prepare(
                    "INSERT INTO dorm_latest (hashed_dir, last_ts, last_kwh) VALUES (?1,?2,?3) " +
                        "ON CONFLICT(hashed_dir) DO UPDATE SET last_ts=excluded.last_ts, last_kwh=excluded.last_kwh"
                )
                .bind(r.hashed_dir, r.ts, r.kwh)
        );
        stmts.push(
            db
                .prepare(
                    "UPDATE crawl_targets SET last_crawled_ts=?2 WHERE hashed_dir=?1"
                )
                .bind(r.hashed_dir, r.ts)
        );
    }
    for (const f of failures) {
        stmts.push(
            db
                .prepare(
                    "INSERT INTO crawl_failures (job_id, hashed_dir, reason, ts) VALUES (?1,?2,?3,?4)"
                )
                .bind(
                    jobId,
                    f.hashed_dir,
                    f.reason,
                    Math.floor(Date.now() / 1000)
                )
        );
    }
    if (body.finished) {
        stmts.push(
            db
                .prepare(
                    "UPDATE crawl_slices SET status='DONE' WHERE job_id=?1 AND slice_index=?2"
                )
                .bind(jobId, idx)
        );

        // finished_slices++; status = "DONE"?
        stmts.push(
            db
                .prepare(
                    "UPDATE crawl_jobs " +
                        "SET finished_slices = finished_slices + 1, " +
                        "    status = CASE WHEN finished_slices + 1 >= total_slices THEN 'DONE' ELSE status END " +
                        "WHERE id = ?1"
                )
                .bind(jobId)
        );

        // status = "DONE_WITH_ERRORS"?
        stmts.push(
            db
                .prepare(
                    "UPDATE crawl_jobs " +
                        "SET status = CASE " +
                        "  WHEN status='DONE' AND EXISTS (SELECT 1 FROM crawl_failures WHERE job_id=?1) " +
                        "  THEN 'DONE_WITH_ERRORS' " +
                        "  ELSE status " +
                        "END " +
                        "WHERE id = ?1"
                )
                .bind(jobId)
        );
    }
    await db.batch(stmts);
}

export interface DbUser {
    id: string;
    email: string;
    pw_hash: string;
    created_ts: number;
}

export async function getUserByEmail(
    db: D1Database,
    email: string
): Promise<DbUser | null> {
    const r = await db
        .prepare(
            "SELECT id, email, pw_hash, created_ts FROM users WHERE email=?1"
        )
        .bind(email)
        .all();
    const row = (r.results as any[])[0];
    return row
        ? {
              id: row.id,
              email: row.email,
              pw_hash: row.pw_hash,
              created_ts: row.created_ts,
          }
        : null;
}

export async function createUser(
    db: D1Database,
    id: string,
    email: string,
    pw_hash: string
) {
    const now = Math.floor(Date.now() / 1000);
    await db
        .prepare(
            "INSERT INTO users (id,email,pw_hash,created_ts) VALUES (?1,?2,?3,?4)"
        )
        .bind(id, email, pw_hash, now)
        .run();
}

// 确保目标存在并启用（订阅时调用）
export async function ensureTargetEnabled(
    db: D1Database,
    hashed_dir: string,
    canonical_id: string
) {
    await db
        .prepare(
            "INSERT INTO crawl_targets (hashed_dir, canonical_id, enabled) " +
                "VALUES (?1,?2,1) " +
                "ON CONFLICT(hashed_dir) DO UPDATE SET enabled=1"
        )
        .bind(hashed_dir, canonical_id)
        .run();
}

// 插入订阅（由触发器保证单用户最多 3 个）
export async function insertSubscription(
    db: D1Database,
    user_id: string,
    hashed_dir: string,
    canonical_id: string,
    email_alert: boolean
) {
    const now = Math.floor(Date.now() / 1000);
    await db
        .prepare(
            "INSERT INTO subscriptions (user_id, hashed_dir, canonical_id, email_alert, created_ts) " +
                "VALUES (?1, ?2, ?3, ?4, ?5)"
        )
        .bind(user_id, hashed_dir, canonical_id, email_alert ? 1 : 0, now)
        .run();
}

// 列出用户订阅（含最新电量）
export async function listSubscriptionsWithLatest(
    db: D1Database,
    user_id: string
): Promise<SubscriptionRow[]> {
    const r = await db
        .prepare(
            "SELECT s.hashed_dir, s.canonical_id, s.email_alert, s.created_ts, " +
                "       dl.last_ts, dl.last_kwh " +
                "FROM subscriptions s " +
                "LEFT JOIN dorm_latest dl ON dl.hashed_dir = s.hashed_dir " +
                "WHERE s.user_id=?1 " +
                "ORDER BY s.created_ts DESC"
        )
        .bind(user_id)
        .all();
    console.log("listSubscriptionsWithLatest:", r.results)
    return r.results as unknown as SubscriptionRow[];
}

// 更新订阅提醒标志
export async function updateSubscriptionAlert(
    db: D1Database,
    user_id: string,
    hashed_dir: string,
    email_alert: boolean
) {
    await db
        .prepare(
            "UPDATE subscriptions SET email_alert=?3 WHERE user_id=?1 AND hashed_dir=?2"
        )
        .bind(user_id, hashed_dir, email_alert ? 1 : 0)
        .run();
}

// 取消订阅；若无人订阅该宿舍则自动禁用爬取
export async function deleteSubscriptionAndMaybeDisableTarget(
    db: D1Database,
    user_id: string,
    hashed_dir: string
) {
    await db
        .prepare("DELETE FROM subscriptions WHERE user_id=?1 AND hashed_dir=?2")
        .bind(user_id, hashed_dir)
        .run();

    const cnt = await db
        .prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE hashed_dir=?1")
        .bind(hashed_dir)
        .all();
    const c = (cnt.results as any[])[0]?.c ?? 0;
    if (c === 0) {
        await db
            .prepare("UPDATE crawl_targets SET enabled=0 WHERE hashed_dir=?1")
            .bind(hashed_dir)
            .run();
    }
}

export async function getSeriesForUser(
  db: D1Database,
  user_id: string,
  hashed_dir: string,
  since: number,
  limit: number
) {
  // 只有在用户确实订阅了该 hashed_dir 时才返回数据；否则返回空数组
  const r = await db
    .prepare(
      "SELECT r.ts, r.kwh FROM readings r " +
      "WHERE r.hashed_dir=?1 AND r.ts>=?2 " +
      "  AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id=?3 AND s.hashed_dir=?1) " +
      "ORDER BY r.ts ASC " +
      "LIMIT ?4"
    )
    .bind(hashed_dir, since, user_id, limit)
    .all();

  // 如果没有订阅，结果会是空数组；为区分“真没订阅”与“有订阅但没数据”，再查一次订阅存在性
  if ((r.results as any[]).length === 0) {
    const sub = await db
      .prepare("SELECT 1 FROM subscriptions WHERE user_id=?1 AND hashed_dir=?2 LIMIT 1")
      .bind(user_id, hashed_dir)
      .all();
    if ((sub.results as any[]).length === 0) return { forbidden: true, points: [] };
  }
  return { forbidden: false, points: r.results as { ts: number; kwh: number }[] };
}

// 查询某宿舍的时序点（供前端绘图）
// export async function getSeries(
//     db: D1Database,
//     hashed_dir: string,
//     since: number,
//     limit: number
// ): Promise<SeriesPoint[]> {
//     const r = await db
//         .prepare(
//             "SELECT ts, kwh FROM readings " +
//                 "WHERE hashed_dir=?1 AND ts>=?2 " +
//                 "ORDER BY ts ASC " +
//                 "LIMIT ?3"
//         )
//         .bind(hashed_dir, since, limit)
//         .all();
//     console.log("getSeries", r.results)
//     return r.results as unknown as SeriesPoint[];
// }

export async function getUserById(db: D1Database, id: string): Promise<DbUser | null> {
  const r = await db
    .prepare("SELECT id, email, pw_hash, created_ts FROM users WHERE id=?1")
    .bind(id)
    .all();
  const row = (r.results as any[])[0];
  return row
    ? { id: row.id, email: row.email, pw_hash: row.pw_hash, created_ts: row.created_ts }
    : null;
}

export async function deleteUser(db: D1Database, user_id: string): Promise<{deleted: number; disabledTargets: number}> {
  // 1) 删除用户（触发 subscriptions 级联删除）
  const del = await db
    .prepare("DELETE FROM users WHERE id=?1")
    .bind(user_id)
    .run();

  // 2) 将“无人订阅”的目标禁用（不物理删除，以便保留历史 readings）
  const upd = await db
    .prepare(
      "UPDATE crawl_targets " +
      "SET enabled=0 " +
      "WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.hashed_dir = crawl_targets.hashed_dir)"
    )
    .run();

  return {
    deleted: del.meta.changes ?? 0,
    disabledTargets: upd.meta.changes ?? 0,
  };
}

export async function deleteUserByEmail(db: D1Database, email: string): Promise<{deleted: number; disabledTargets: number}> {
  // 查 id，再调上面的 deleteUser
  const r = await db
    .prepare("SELECT id FROM users WHERE email=?1")
    .bind(email)
    .all();
  const row = (r.results as any[])[0];
  if (!row) return { deleted: 0, disabledTargets: 0 };
  return deleteUser(db, row.id);
}
