import crypto from "node:crypto";
import { env } from "./env";

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Protects the app's operator API (runs, dashboard, approvals). Production requires ADMIN_API_TOKEN. */
export function adminAuth(req: Request): Response | null {
  const expected = env.adminToken;
  if (!expected) return env.isProd ? new Response(JSON.stringify({ error: "ADMIN_API_TOKEN not configured" }), { status: 503 }) : null;
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return got && eq(got, expected) ? null : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
}
