/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ACTIONS_SHARED_SECRET: string;
  GITHUB_PAT: string;
  GH_OWNER: string;
  GH_REPO: string;
  GH_WORKFLOW: string; // e.g. "crawler.yml"
  GH_REF?: string;     // default "main"
  USER_JWT_SECRET: string,
  DORM_HASH_KEY: string
}

export interface Target {
    hashed_dir: string;
    canonical_id: string;
}

export interface SeriesPoint {
    ts: number;
    kwh: number;
}


export interface SubscriptionRow {
    hashed_dir: string;
    canonical_id: string;
    email_alert: number;
    created_ts: number;
    last_ts?: number | null;
    last_kwh?: number | null;
    last_kw?: number | null;
}
