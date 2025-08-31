export async function sign(env: any, payload: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ACTIONS_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const h = btoa(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const b = btoa(JSON.stringify(payload));
  const data = `${h}.${b}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${s}`;
}

export async function verify(env: any, token: string, leeway=30): Promise<any> {
  const [h,b,s] = token.split(".");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ACTIONS_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC", key,
    Uint8Array.from(atob(s as string), c => c.charCodeAt(0)),
    new TextEncoder().encode(`${h}.${b}`)
  );
  if (!ok) throw new Error("BAD_SIG");
  const payload = JSON.parse(atob(b as string));
  const now = Math.floor(Date.now()/1000);
  if (typeof payload.exp === "number" && payload.exp + leeway < now) throw new Error("EXPIRED");
  return payload;
}
