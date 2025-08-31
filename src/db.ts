export interface Target {
  hashed_dir: string;
  canonical_id: string;
}

// export async function fetchEnabledTargets(db: D1Database): Promise<string[]> {
//   const r = await db.prepare("SELECT hashed_dir FROM crawl_targets WHERE enabled=1").all();
//   return (r.results as any[]).map(x => x.hashed_dir);
// }

export async function fetchEnabledTargets(db: D1Database): Promise<Target[]> {
  const r = await db.prepare(
    "SELECT hashed_dir, canonical_id FROM crawl_targets WHERE enabled=1"
  ).all();
  return (r.results as any[]).map(x => ({
    hashed_dir: x.hashed_dir,
    canonical_id: x.canonical_id
  }));
}

export async function createJobWithSlices(
  db: D1Database, jobId: string, slices: Target[][]
) {
  const now = Math.floor(Date.now()/1000);
  const batch = db.batch([
    db.prepare(
      "INSERT INTO crawl_jobs (id,created_ts,status,total_slices) VALUES (?1,?2,'PENDING',?3)"
    ).bind(jobId, now, slices.length),
    ...slices.map((arr, i) =>
      db.prepare(
        "INSERT INTO crawl_slices (job_id,slice_index,status,payload) VALUES (?1,?2,'PENDING',?3)"
      ).bind(jobId, i, JSON.stringify(arr))
    )
  ]);
  await batch;
}

// export async function claimOneSlice(db: D1Database, jobId: string) {
//   // 先找一个 PENDING，尝试占有（RUNNING）
//   const trySel = await db.prepare(
//     "SELECT slice_index, payload FROM crawl_slices WHERE job_id=?1 AND status='PENDING' LIMIT 1"
//   ).bind(jobId).all();
//   const sel = (trySel.results as any[])[0];
//   if (!sel) return null;

//   const ok = await db.prepare(
//     "UPDATE crawl_slices SET status='RUNNING' WHERE job_id=?1 AND slice_index=?2 AND status='PENDING'"
//   ).bind(jobId, sel.slice_index).run();

//   if (ok.meta.changes > 0) {
//     return { slice_index: sel.slice_index, targets: JSON.parse(sel.payload) as string[] };
//   }
//   return null;
// }
export async function claimOneSlice(db: D1Database, jobId: string) {
  const sel = await db.prepare(
    "SELECT slice_index, payload FROM crawl_slices WHERE job_id=?1 AND status='PENDING' LIMIT 1"
  ).bind(jobId).all();
  const row = (sel.results as any[])[0];
  if (!row) return null;

  const upd = await db.prepare(
    "UPDATE crawl_slices SET status='RUNNING' WHERE job_id=?1 AND slice_index=?2 AND status='PENDING'"
  ).bind(jobId, row.slice_index).run();

  if (upd.meta.changes > 0) {
    // targets: Array<{hashed_dir, canonical_id}>
    return { slice_index: row.slice_index, targets: JSON.parse(row.payload) as Target[] };
  }
  return null;
}

export async function ingestBatch(db: D1Database, body: any) {
  const readings = body.readings as {hashed_dir:string, ts:number, kwh:number, ok?:boolean}[];
  const failures = body.failures as {hashed_dir:string, reason:string}[] || [];
  const jobId = body.job_id as string;
  const idx = body.slice_index as number;

  const stmts = [];
  for (const r of readings) {
    stmts.push(
      db.prepare("INSERT OR IGNORE INTO readings (hashed_dir, ts, kwh, ok) VALUES (?1,?2,?3,?4)")
        .bind(r.hashed_dir, r.ts, r.kwh, r.ok?1:0)
    );
    stmts.push(
      db.prepare(
        "INSERT INTO dorm_latest (hashed_dir, last_ts, last_kwh) VALUES (?1,?2,?3) " +
        "ON CONFLICT(hashed_dir) DO UPDATE SET last_ts=excluded.last_ts, last_kwh=excluded.last_kwh"
      ).bind(r.hashed_dir, r.ts, r.kwh)
    );
    stmts.push(
      db.prepare("UPDATE crawl_targets SET last_crawled_ts=?2 WHERE hashed_dir=?1")
        .bind(r.hashed_dir, r.ts)
    );
  }
  for (const f of failures) {
    stmts.push(
      db.prepare("INSERT INTO crawl_failures (job_id, hashed_dir, reason, ts) VALUES (?1,?2,?3,?4)")
        .bind(jobId, f.hashed_dir, f.reason, Math.floor(Date.now()/1000))
    );
  }
  if (body.finished) {
    stmts.push(
      db.prepare("UPDATE crawl_slices SET status='DONE' WHERE job_id=?1 AND slice_index=?2").bind(jobId, idx)
    );
    stmts.push(
      db.prepare("UPDATE crawl_jobs SET finished_slices=finished_slices+1 WHERE id=?1").bind(jobId)
    );
  }
  await db.batch(stmts);
}
