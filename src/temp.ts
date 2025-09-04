// src/index.ts
import type { Env } from "./types"; // 如果你已有 types.ts，里面定义了 Env；否则见下方内联版本
import {
  fetchEnabledTargets,
  createJobWithSlices,
  claimOneSlice,
  ingestBatch,
  ensureTargetEnabled,
  insertSubscription,
  listSubscriptionsWithLatest,
  updateSubscriptionAlert,
  deleteSubscriptionAndMaybeDisableTarget,
  getSeries,
  type Target,
} from "./db";
import { sign as signActionsJwt, verify as verifyActionsJwt } from "./jwt"; // 爬虫用 JWT（ACTIONS_SHARED_SECRET）
import { dispatchWorkflow } from "./github";
import {
  hashPassword,
  verifyPassword,
  signUser,
  verifyUser,
} from "./auth"; // 用户登录用 JWT（USER_JWT_SECRET）
import { hmacDorm } from "./hmac";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function requireUser(req: Request, env: Env) {
  const tok = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  return await verifyUser(env, tok);
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function parseJSON<T = any>(req: Request): Promise<T> {
  try {
    return await req.json();
  } catch {
    throw new Response("Bad JSON", { status: 400 });
  }
}

export default {
  // ====== Cron 编排：每 10 分钟创建一个 Job 并触发 Actions ======
  async scheduled(_evt: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const targets: Target[] = await fetchEnabledTargets(env.DB);
    if (targets.length === 0) return;

    const slices = chunk<Target>(targets, 50);
    const jobId = crypto.randomUUID();

    await createJobWithSlices(env.DB, jobId, slices);

    const actionsToken = await signActionsJwt(env, {
      iss: "dormitricity-orchestrator",
      aud: "gh-actions",
      job_id: jobId,
      scope: ["claim", "ingest"],
      exp: Math.floor(Date.now() / 1000) + 10 * 60,
    });

    await dispatchWorkflow(env, { job_id: jobId, token: actionsToken });
  },

  // ====== HTTP 路由 ======
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    // --- Health ---
    if (pathname === "/" && req.method === "GET") {
      return json({ ok: true, name: "Dormitricity backend" });
    }

    // ========= 爬虫 Actions 接口（JWT: ACTIONS_SHARED_SECRET） =========
    if (pathname === "/orchestrator/claim" && req.method === "POST") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      const payload = await verifyActionsJwt(env, token).catch(() => null);
      if (!payload || !payload.scope?.includes("claim"))
        return json({ error: "FORBIDDEN" }, 403);

      const { job_id } = await parseJSON<{ job_id: string }>(req);
      if (payload.job_id !== job_id) return json({ error: "BAD_JOB" }, 400);

      const slice = await claimOneSlice(env.DB, job_id);
      if (!slice) return new Response(null, { status: 204 });
      return json({
        job_id,
        slice_index: (slice as any).slice_index,
        targets: (slice as any).targets,
        deadline_ts: Math.floor(Date.now() / 1000) + 8 * 60,
      });
    }

    if (pathname === "/ingest" && req.method === "POST") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      const payload = await verifyActionsJwt(env, token).catch(() => null);
      if (!payload || !payload.scope?.includes("ingest"))
        return json({ error: "FORBIDDEN" }, 403);

      const body = await parseJSON(req);
      if (payload.job_id !== body.job_id) return json({ error: "BAD_JOB" }, 400);

      await ingestBatch(env.DB, body);
      return json({ ok: true });
    }

    // ========= 用户认证 =========
    if (pathname === "/auth/register" && req.method === "POST") {
      const { email, password } = await parseJSON<{ email: string; password: string }>(req);
      if (!email || !password) return json({ error: "BAD_INPUT" }, 400);

      const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email=?1")
        .bind(email)
        .all();
      if (exists.results.length) return json({ error: "EMAIL_IN_USE" }, 409);

      const uid = crypto.randomUUID();
      const pw_hash = await hashPassword(password);
      await env.DB.prepare(
        "INSERT INTO users (id,email,pw_hash,created_ts) VALUES (?1,?2,?3,?4)"
      )
        .bind(uid, email, pw_hash, Math.floor(Date.now() / 1000))
        .run();

      const token = await signUser(env, { uid, email });
      return json({ token });
    }

    if (pathname === "/auth/login" && req.method === "POST") {
      const { email, password } = await parseJSON<{ email: string; password: string }>(req);
      const r = await env.DB.prepare("SELECT id, pw_hash FROM users WHERE email=?1")
        .bind(email)
        .all();
      const row = (r.results as any[])[0];
      if (!row) return json({ error: "BAD_CREDENTIALS" }, 401);
      const ok = await verifyPassword(password, row.pw_hash);
      if (!ok) return json({ error: "BAD_CREDENTIALS" }, 401);
      const token = await signUser(env, { uid: row.id, email });
      return json({ token });
    }

    // ========= 订阅 CRUD =========
    if (pathname === "/subs" && req.method === "GET") {
      const user = await requireUser(req, env);
      if (!user) return json({ error: "UNAUTHORIZED" }, 401);
      const items = await listSubscriptionsWithLatest(env.DB, user.uid);
      return json({ items });
    }

    if (pathname === "/subs" && req.method === "POST") {
      const user = await requireUser(req, env);
      if (!user) return json({ error: "UNAUTHORIZED" }, 401);
      const { campus, building, floor, room, email_alert } = await parseJSON<{
        campus: string;
        building: string;
        floor: string;
        room: string;
        email_alert?: boolean;
      }>(req);

      const canonical = `${campus}:${building}:${floor}:${room}`;
      const hashed = await hmacDorm(env, canonical);

      try {
        await Promise.all([
          ensureTargetEnabled(env.DB, hashed, canonical),
          insertSubscription(env.DB, user.uid, hashed, canonical, !!email_alert),
        ]);
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes("MAX_SUBS_REACHED")) return json({ error: "MAX_SUBS_REACHED" }, 400);
        if (msg.includes("UNIQUE")) return json({ error: "ALREADY_SUBSCRIBED" }, 409);
        return json({ error: "DB_ERROR", detail: msg }, 500);
      }
      return json({ ok: true, hashed_dir: hashed });
    }

    if (pathname.startsWith("/subs/") && req.method === "PUT") {
      const user = await requireUser(req, env);
      if (!user) return json({ error: "UNAUTHORIZED" }, 401);
      const hashed = pathname.split("/").pop()!;
      const { email_alert } = await parseJSON<{ email_alert: boolean }>(req);
      await updateSubscriptionAlert(env.DB, user.uid, hashed, !!email_alert);
      return json({ ok: true });
    }

    if (pathname.startsWith("/subs/") && req.method === "DELETE") {
      const user = await requireUser(req, env);
      if (!user) return json({ error: "UNAUTHORIZED" }, 401);
      const hashed = pathname.split("/").pop()!;
      await deleteSubscriptionAndMaybeDisableTarget(env.DB, user.uid, hashed);
      return json({ ok: true });
    }

    // ========= 时序查询 =========
    // GET /series/:hashed_dir?since=unix&limit=1000
    if (pathname.startsWith("/series/") && req.method === "GET") {
      const hashed = pathname.split("/").pop()!;
      const since = parseInt(searchParams.get("since") || "0", 10);
      const limit = Math.min(parseInt(searchParams.get("limit") || "1000", 10), 5000);
      const points = await getSeries(env.DB, hashed, isNaN(since) ? 0 : since, limit);
      return json({ hashed_dir: hashed, points });
    }

    return new Response("Not Found", { status: 404 });
  },
};
