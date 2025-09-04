export const ALLOW_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:13001",
  "https://your-frontend-domain.com",
]);

export function buildCorsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    // 你用到了 Authorization + JSON
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    // 避免缓存错配
    "Vary": "Origin",
  };
}

export function isPreflight(req: Request) {
  return req.method === "OPTIONS" &&
    req.headers.get("Origin") &&
    req.headers.get("Access-Control-Request-Method");
}