import { sign as signActionsJwt, verify as verifyActionsJwt } from "./jwt.js";
import {
    fetchEnabledTargets,
    createJobWithSlices,
    claimOneSlice,
    ingestBatch,
    ensureTargetEnabled,
    insertSubscription,
    listSubscriptionsWithLatest,
    // updateSubscriptionAlert,
    deleteSubscriptionAndMaybeDisableTarget,
    getLatest,
    getSeriesForUser,
    getUserById,
    deleteUser,
    // setAlertRuleByKey,
    // disableAlertRuleByKey,
    // updateNotifyChannel,
    updateSubscriptionNotify,
    verifySubscription,
} from "./db.js";
import { dispatchWorkflow } from "./github.js";
import { sendTestNotification } from "./notify.js";
import type { Env, NotifyChannel, Target } from "./types.js";
import { hashPassword, verifyPassword, signUser, verifyUser } from "./auth.js";
import { hmacDorm } from "./hmac.js";
import { ALLOW_ORIGINS, buildCorsHeaders, isPreflight } from "./cors.js";

function json(data: any, status = 200) {
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

const scheduled = async (_: ScheduledEvent | undefined, env: Env) => {
    console.log("in scheduled()");
    const targets: Target[] = await fetchEnabledTargets(env.DB);
    if (targets.length === 0) return;

    const slices = chunk<Target>(targets, 50);
    const jobId = crypto.randomUUID();
    await createJobWithSlices(env.DB, jobId, slices);

    const token = await signActionsJwt(env, {
        iss: "dormitricity-orchestrator",
        aud: "gh-actions",
        job_id: jobId,
        scope: ["claim", "ingest"],
        exp: Math.floor(Date.now() / 1000) + 10 * 60,
    });

    await dispatchWorkflow(env, { job_id: jobId, token });
};

const route = async (req: Request, env: Env) => {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    if (pathname === "/" && req.method === "GET") {
        return json({ ok: true, name: "Dormitricity backend" });
    }

    if (url.pathname === "/trigger") {
        await scheduled(undefined, env);
        return new Response("scheduled() triggered manually");
    }

    if (url.pathname === "/crawler/claim" && req.method === "POST") {
        const token = (req.headers.get("authorization") || "").replace(
            /^Bearer\s+/i,
            ""
        );
        const payload = await verifyActionsJwt(env, token);
        if (!payload.scope?.includes("claim"))
            return new Response("forbidden", { status: 403 });
        const body = (await req.json()) as { job_id: string };
        const { job_id } = body;
        // const { job_id } = await req.json();
        if (payload.job_id !== body.job_id)
            return new Response("bad job", { status: 400 });

        const slice = await claimOneSlice(env.DB, job_id);
        if (!slice) return new Response(null, { status: 204 });
        return Response.json({
            job_id,
            ...slice,
            deadline_ts: Math.floor(Date.now() / 1000) + 8 * 60,
        });
        /*
            {
              "job_id": "uuid",
              "slice_index": 0,
              "targets": [
                { "hashed_dir":"hashA...", "canonical_id":"campus:1:2:301" },
                { "hashed_dir":"hashB...", "canonical_id":"campus:1:2:302" }
              ],
              "deadline_ts": 169...
            }
            */
    }

    if (url.pathname === "/crawler/ingest" && req.method === "POST") {
        const token = (req.headers.get("authorization") || "").replace(
            /^Bearer\s+/i,
            ""
        );
        const payload = await verifyActionsJwt(env, token);
        if (!payload.scope?.includes("ingest"))
            return new Response("forbidden", { status: 403 });

        const body = (await req.json()) as { job_id: string };
        if (payload.job_id !== body.job_id)
            return new Response("bad job", { status: 400 });

        await ingestBatch(env.DB, body);
        return new Response("OK");
    }

    // ========= 用户认证 =========
    if (pathname === "/auth/register" && req.method === "POST") {
        const { email, password } = await parseJSON<{
            email: string;
            password: string;
        }>(req);
        if (!email || !password) return json({ error: "BAD_INPUT" }, 400);

        const exists = await env.DB.prepare(
            "SELECT 1 FROM users WHERE email=?1"
        )
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
        const { email, password } = await parseJSON<{
            email: string;
            password: string;
        }>(req);
        const r = await env.DB.prepare(
            "SELECT id, pw_hash FROM users WHERE email=?1"
        )
            .bind(email)
            .all();
        const row = (r.results as any[])[0];
        if (!row) return json({ error: "BAD_CREDENTIALS" }, 401);
        const ok = await verifyPassword(password, row.pw_hash);
        if (!ok) return json({ error: "BAD_CREDENTIALS" }, 401);
        const token = await signUser(env, { uid: row.id, email });
        return json({ token });
    }

    // list subscriptions
    if (pathname === "/subs" && req.method === "GET") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);
        const items = await listSubscriptionsWithLatest(env.DB, user.uid);
        return json({ items });
    }

    // add subscription
    if (pathname === "/subs" && req.method === "POST") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);
        const { canonical_id } = await parseJSON<{
            canonical_id: string;
        }>(req);

        const hashed = await hmacDorm(env, canonical_id);

        try {
            await Promise.all([
                ensureTargetEnabled(env.DB, hashed, canonical_id),
                insertSubscription(env.DB, user.uid, hashed, canonical_id),
            ]);
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (msg.includes("MAX_SUBS_REACHED"))
                return json({ error: "MAX_SUBS_REACHED" }, 400);
            if (msg.includes("UNIQUE"))
                return json({ error: "ALREADY_SUBSCRIBED" }, 409);
            return json({ error: "DB_ERROR", detail: msg }, 500);
        }
        return json({ ok: true, hashed_dir: hashed });
    }

    // subscription settings
    if (pathname.startsWith("/subs/") && req.method === "PUT") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);
        const hashed = pathname.split("/").pop()!;
        if (!verifySubscription(env.DB, user.uid, hashed)) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "The user does not have the subscription specified",
                },
                400
            );
        }
        const { threshold_kwh, within_hours, notify_channel, notify_token, cooldown_sec } =
            await parseJSON<{
                threshold_kwh?: number;
                within_hours?: number;
                notify_channel?: NotifyChannel;
                notify_token?: string;
                cooldown_sec?: number;
            }>(req);

        if (threshold_kwh === undefined || within_hours === undefined || !notify_channel || cooldown_sec === undefined) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "threshold_kwh, within_hours, cooldown_sec and notify_channel are required",
                },
                400
            );
        }

        const allowedCooldowns = [43200, 64800, 86400, 172800];
        if (!allowedCooldowns.includes(cooldown_sec)) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "Invalid cooldown_sec value",
                },
                400
            );
        }

        if (notify_channel != "none" && !notify_token) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "notify_token required",
                },
                400
            );
        }

        // TODO: check token/channel integrity
        try {
            await updateSubscriptionNotify(
                env.DB,
                user.uid,
                hashed,
                threshold_kwh,
                within_hours,
                cooldown_sec,
                notify_channel,
                notify_token
            );
        } catch (e: any) {
            return json(
                { error: "ERROR", detail: String(e?.message || e) },
                500
            );
        }
        return json({ ok: true });
    }

    // delete subscription
    if (pathname.startsWith("/subs/") && req.method === "DELETE") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);
        const hashed = pathname.split("/").pop()!;
        await deleteSubscriptionAndMaybeDisableTarget(env.DB, user.uid, hashed);
        return json({ ok: true });
    }

    // test notification
    if (pathname.startsWith("/subs/test-notify") && req.method === "POST") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);

        const { notify_channel, notify_token } = await parseJSON<{
            notify_channel: NotifyChannel;
            notify_token: string;
        }>(req);

        if (!notify_channel || !notify_token) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "notify_channel and notify_token are required",
                },
                400
            );
        }

        const result = await sendTestNotification(notify_channel, notify_token);
        return json(result);
    }

    // ========= 时序查询 =========
    // GET /series/:hashed_dir?since=unix&limit=1000
    if (pathname.startsWith("/series/") && req.method === "GET") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);

        const hashed = pathname.split("/").pop()!;
        const since = parseInt(searchParams.get("since") || "0", 10);
        const limit = Math.min(
            parseInt(searchParams.get("limit") || "1000", 10),
            5000
        );

        const { forbidden, points } = await getSeriesForUser(
            env.DB,
            user.uid,
            hashed,
            isNaN(since) ? 0 : since,
            limit
        );

        const result = await getLatest(env.DB, user.uid, hashed);

        if (forbidden || result === null)
            return json({ error: "NOT_FOUND_OR_EMPTY" }, 404);

        return json({ hashed_dir: hashed, points, latest: result });
    }

    if (pathname === "/auth/delete" && req.method === "POST") {
        const user = await requireUser(req, env);
        if (!user) return json({ error: "UNAUTHORIZED" }, 401);

        const { email } = await parseJSON<{ email: string }>(req);
        if (!email) return json({ error: "EMAIL_REQUIRED" }, 400);

        // 取数据库中的邮箱并校验（大小写不敏感，去除首尾空格）
        const dbUser = await getUserById(env.DB, user.uid);
        if (!dbUser) return json({ error: "USER_NOT_FOUND" }, 404);

        const normalize = (s: string) => s.trim().toLowerCase();
        if (normalize(email) !== normalize(dbUser.email)) {
            return json({ error: "EMAIL_MISMATCH" }, 400);
        }

        // 通过校验，执行删除（含级联清理订阅 & 禁用无人订阅宿舍）
        const res = await deleteUser(env.DB, user.uid);
        return json({ ok: true, ...res }); // { ok:true, deleted:1, disabledTargets:N }
    }



    return new Response("Not Found", { status: 404 });
};

export default {
    scheduled,

    async fetch(req: Request, env: Env) {
        // check preflight/CORS
        const origin = req.headers.get("Origin") || "";
        const okOrigin = ALLOW_ORIGINS.has(origin);
        if (isPreflight(req)) {
            return new Response(null, {
                status: okOrigin ? 204 : 403,
                headers: okOrigin ? buildCorsHeaders(origin) : {},
            });
        }

        // 你原有的路由处理
        const res = await route(req, env); // 假设你把原逻辑封装成 route()

        // 给实际响应也加上 CORS 头（仅允许的来源）
        if (okOrigin) {
            const h = new Headers(res.headers);
            const cors = buildCorsHeaders(origin);
            for (const [k, v] of Object.entries(cors)) h.set(k, v);
            return new Response(res.body, { status: res.status, headers: h });
        }
        return res;
    },
};
