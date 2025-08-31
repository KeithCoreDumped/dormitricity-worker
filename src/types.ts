/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ACTIONS_SHARED_SECRET: string;
  GITHUB_PAT: string;
  GH_OWNER: string;
  GH_REPO: string;
  GH_WORKFLOW: string; // e.g. "crawler.yml"
  GH_REF?: string;     // default "main"
}
