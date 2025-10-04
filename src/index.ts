import { sign as signActionsJwt, verify as verifyActionsJwt } from "./jwt.js";
import {
    fetchEnabledTargets,
    createJobWithSlices,
    claimOneSlice,
    ingestBatch,
    ensureTargetEnabled,
    insertSubscription,
    listSubscriptionsWithLatest,
    deleteSubscriptionAndMaybeDisableTarget,
    getLatest,
    getSeriesForUser,
    getUserById,
    deleteUser,
    updateSubscriptionNotify,
    verifySubscription,
    getSubscriptionsForHashedDir,
    updateLastNotifiedTimestamp,
} from "./db.js";
import { dispatchWorkflow } from "./github.js";
import { sendTestNotification, sendAlert } from "./notify.js";
import type { Env, NotifyChannel, SetAlertOptions, Target } from "./types.js";
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

const scheduled = async (_: unknown | undefined, env: Env) => {
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
        const { token } = await parseJSON<{
            token: string;
        }>(req);
        if (token !== env.TRIGGER_SECRET) {
            return new Response("Unauthorized", { status: 401 });
        }
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
        if (payload.job_id !== body.job_id)
            return new Response("bad job", { status: 400 });

        const slice = await claimOneSlice(env.DB, job_id);
        if (!slice) return new Response(null, { status: 204 });
        return Response.json({
            job_id,
            ...slice,
            deadline_ts: Math.floor(Date.now() / 1000) + 8 * 60,
        });
    }

    if (url.pathname === "/crawler/ingest" && req.method === "POST") {
        const token = (req.headers.get("authorization") || "").replace(
            /^Bearer\s+/i,
            ""
        );
        const payload = await verifyActionsJwt(env, token);
        if (!payload.scope?.includes("ingest"))
            return new Response("forbidden", { status: 403 });

        const body = (await req.json()) as {
            job_id: string;
            readings: { hashed_dir: string }[];
        };
        if (payload.job_id !== body.job_id)
            return new Response("bad job", { status: 400 });

        await ingestBatch(env.DB, body);

        // --- BEGIN NOTIFICATION LOGIC ---
        try {
            const now = Math.floor(Date.now() / 1000);
            // Get unique hashed_dirs from the ingested batch
            const hashed_dirs = [
                ...new Set(body.readings.map((r) => r.hashed_dir)),
            ];

            for (const hashed_dir of hashed_dirs) {
                const subs = await getSubscriptionsForHashedDir(
                    env.DB,
                    hashed_dir
                );

                for (const sub of subs) {
                    // Null safety checks for properties that can be null from the database query
                    if (sub.last_kwh === null || sub.last_kwh === undefined) {
                        continue;
                    }

                    // Cooldown check
                    if (now - sub.last_alert_ts < sub.cooldown_sec) {
                        continue;
                    }

                    let alertSent = false;

                    // 1. Low power threshold
                    if (
                        sub.threshold_kwh > 0 &&
                        sub.last_kwh < sub.threshold_kwh
                    ) {
                        console.log(
                            `[ALERT] Low power for ${sub.canonical_id}`
                        );
                        const res = await sendAlert(sub, "low_power", {});
                        if (res.ok) {
                            await updateLastNotifiedTimestamp(
                                env.DB,
                                sub.user_id,
                                sub.hashed_dir
                            );
                            alertSent = true;
                        } else {
                            console.error(
                                `[ALERT_FAIL] Failed to send low_power alert for ${sub.canonical_id}: ${res.error}`
                            );
                        }
                    }

                    // 2. Depletion time, only if low power alert was not sent
                    if (
                        !alertSent &&
                        sub.within_hours > 0 &&
                        sub.last_kw &&
                        sub.last_kw < 0
                    ) {
                        const hours_remaining = sub.last_kwh / -sub.last_kw;
                        if (hours_remaining < sub.within_hours) {
                            console.log(
                                `[ALERT] Depletion imminent for ${sub.canonical_id}`
                            );
                            const res = await sendAlert(
                                sub,
                                "depletion_imminent",
                                { hours_remaining }
                            );
                            if (res.ok) {
                                await updateLastNotifiedTimestamp(
                                    env.DB,
                                    sub.user_id,
                                    sub.hashed_dir
                                );
                            } else {
                                console.error(
                                    `[ALERT_FAIL] Failed to send depletion_imminent alert for ${sub.canonical_id}: ${res.error}`
                                );
                            }
                        }
                    }
                }
            }
        } catch (e: any) {
            console.error(
                "Error during notification dispatch after ingest:",
                e
            );
        }
        // --- END NOTIFICATION LOGIC ---

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
        const {
            threshold_kwh,
            within_hours,
            notify_channel,
            notify_token,
            cooldown_sec,
        } = await parseJSON<
            SetAlertOptions & {
                notify_channel: NotifyChannel;
                notify_token?: string;
            }
        >(req);

        if (!notify_channel) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "notify_channel is required",
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

        const { notify_channel, notify_token, canonical_id } = await parseJSON<{
            notify_channel: NotifyChannel;
            notify_token: string;
            canonical_id: string;
        }>(req);

        if (!notify_channel || !notify_token || !canonical_id) {
            return json(
                {
                    error: "BAD_REQUEST",
                    detail: "notify_channel, notify_token, and canonical_id are required",
                },
                400
            );
        }

        const result = await sendTestNotification(
            notify_channel,
            notify_token,
            canonical_id
        );
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

        const dbUser = await getUserById(env.DB, user.uid);
        if (!dbUser) return json({ error: "USER_NOT_FOUND" }, 404);

        const normalize = (s: string) => s.trim().toLowerCase();
        if (normalize(email) !== normalize(dbUser.email)) {
            return json({ error: "EMAIL_MISMATCH" }, 400);
        }

        const res = await deleteUser(env.DB, user.uid);
        return json({ ok: true, ...res });
    }

    return new Response("Not Found", { status: 404 });
};

export default {
    scheduled,

    async fetch(req: Request, env: Env) {
        const origin = req.headers.get("Origin") || "";
        const okOrigin = ALLOW_ORIGINS.has(origin);
        if (isPreflight(req)) {
            return new Response(null, {
                status: okOrigin ? 204 : 403,
                headers: okOrigin ? buildCorsHeaders(origin) : {},
            });
        }

        const res = await route(req, env);

        if (okOrigin) {
            const h = new Headers(res.headers);
            const cors = buildCorsHeaders(origin);
            for (const [k, v] of Object.entries(cors)) h.set(k, v);
            return new Response(res.body, { status: res.status, headers: h });
        }
        return res;
    },
};
