// src/hmac.ts
import type { Env } from "./types.js";

export async function hmacDorm(env: Env, canonicalId: string) {
  const key = await crypto.subtle.importKey("raw",
    new TextEncoder().encode(env.DORM_HASH_KEY),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalId));
  // 用 hex 作为 hashed_dir
  return [...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
