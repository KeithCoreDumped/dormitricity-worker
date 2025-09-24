// / <reference types="@cloudflare/workers-types" />
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
    DB: D1Database;
    ACTIONS_SHARED_SECRET: string;
    GITHUB_PAT: string;
    GH_OWNER: string;
    GH_REPO: string;
    GH_WORKFLOW: string; // e.g. "crawler.yml"
    GH_REF?: string; // default "main"
    USER_JWT_SECRET: string;
    DORM_HASH_KEY: string;
}

export interface Target {
    hashed_dir: string;
    canonical_id: string;
}

export interface SeriesPoint {
    ts: number;
    kwh: number;
}

export type NotifyChannel = "none" | "wxwork" | "feishu" | "serverchan";

export interface SubscriptionRow {
    hashed_dir: string;
    canonical_id: string;
    created_ts: number;
    notify_channel: NotifyChannel;
    notify_token?: string | null;
    threshold_kwh?: number | null;
    within_hours?: number | null;
    cooldown_sec?: number | null;
    last_alert_ts?: number | null;
    last_ts?: number | null;
    last_kwh?: number | null;
    last_kw?: number | null;
}

export type RuleType = "low_kwh" | "deplete";

export interface SetAlertOptions {
    threshold_kwh?: number; // 仅 low_kwh 用
    within_hours?: number; // 仅 deplete 用
    cooldown_sec?: number; // 建议 >= 43200 (12h)
}
