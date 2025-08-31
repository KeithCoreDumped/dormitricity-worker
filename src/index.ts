import { sign, verify } from "./jwt.js";
import { fetchEnabledTargets, createJobWithSlices, claimOneSlice, ingestBatch } from "./db.js";
import { dispatchWorkflow } from "./github.js";
import type { Env } from "./types.js";
import type { Target } from "./db.js";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
  return out;
}

const scheduled = async (_: ScheduledEvent | undefined, env: Env) => {
    console.log("in scheduled()")
    const targets: Target[] = await fetchEnabledTargets(env.DB);
    if (targets.length === 0) return;

    const slices = chunk<Target>(targets, 50);
    const jobId = crypto.randomUUID();
    await createJobWithSlices(env.DB, jobId, slices);

    const token = await sign(env, {
      iss: "dormitricity-orchestrator",
      aud: "gh-actions",
      job_id: jobId,
      scope: ["claim","ingest"],
      exp: Math.floor(Date.now()/1000) + 10*60
    });
    
    await dispatchWorkflow(env, { job_id: jobId, token });
  }
export default {
  scheduled,
  
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    
    if (url.pathname === "/trigger") {
      await scheduled(undefined, env);
      return new Response("scheduled() triggered manually");
    }

    if (url.pathname === "/orchestrator/claim" && req.method === "POST") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const payload = await verify(env, token);
      if (!payload.scope?.includes("claim")) return new Response("forbidden", { status: 403 });
      const body = await req.json() as { job_id: string };
      const { job_id } = body;
      // const { job_id } = await req.json();
      if (payload.job_id !== body.job_id) return new Response("bad job", { status: 400 });

      const slice = await claimOneSlice(env.DB, job_id);
      if (!slice) return new Response(null, { status: 204 });
      return Response.json({ job_id, ...slice, deadline_ts: Math.floor(Date.now()/1000)+8*60 });
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

    if (url.pathname === "/ingest" && req.method === "POST") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const payload = await verify(env, token);
      if (!payload.scope?.includes("ingest")) return new Response("forbidden", { status: 403 });

      // const body = await req.json();
      const body = await req.json() as { job_id: string };
      if (payload.job_id !== body.job_id) return new Response("bad job", { status: 400 });

      await ingestBatch(env.DB, body);
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};
