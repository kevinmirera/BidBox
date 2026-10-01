import crypto from "node:crypto";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerBidBox } from "../../../mcp/server";
import { env } from "../../../lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => registerBidBox(server),
  { serverInfo: { name: "bid-box", version: "0.1.0" } },
);

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Bearer-token auth. In production a token is mandatory (fail closed). In local dev, no token = open.
const authed = withMcpAuth(handler, (_req, bearer) => {
  const expected = env.mcpAuthToken;
  if (!expected) return env.isProd ? undefined : { token: "dev-open", clientId: "dev", scopes: [] };
  return bearer && eq(bearer, expected) ? { token: bearer, clientId: "bidbox-client", scopes: [] } : undefined;
}, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
