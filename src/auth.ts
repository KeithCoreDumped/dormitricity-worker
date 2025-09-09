// src/auth.ts
import type { Env } from "./types.js";
export interface JwtUser { uid: string; email: string; exp: number; }

export async function hashPassword(pw: string, salt?: Uint8Array) {
  const enc = new TextEncoder();
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: s as BufferSource, iterations: 10_000 }, key, 256
  );
  const out = new Uint8Array(bits);
  return `pbkdf2$10000$${btoa(String.fromCharCode(...s))}$${btoa(String.fromCharCode(...out))}`;
}

export async function verifyPassword(pw: string, stored: string) {
  const [algo, iters, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2") return false;
  if (!saltB64 || !iters) return false;
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: parseInt(iters) }, key, 256
  );
  const out = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return out === hashB64;
}

export async function signUser(env: Env, payload: Omit<JwtUser,"exp">, ttlSec=7*24*3600) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.USER_JWT_SECRET),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const header = btoa(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const exp = Math.floor(Date.now()/1000) + ttlSec;
  const body = btoa(JSON.stringify({ ...payload, exp }));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigb64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigb64}`;
}

export async function verifyUser(env: Env, token: string): Promise<JwtUser|null> {
  try {
    const [h,b,s] = token.split(".");
    if (!s || !b) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.USER_JWT_SECRET),
      { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key,
      Uint8Array.from(atob(s), c=>c.charCodeAt(0)),
      new TextEncoder().encode(`${h}.${b}`));
    if (!ok) return null;
    const pl: JwtUser = JSON.parse(atob(b));
    if (pl.exp < Math.floor(Date.now()/1000)) return null;
    return pl;
  } catch { return null; }
}