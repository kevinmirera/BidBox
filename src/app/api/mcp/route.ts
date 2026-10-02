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
const authed = withMcpAuth(handler, (req, bearer) => {
  const expected = env.mcpAuthToken;
  if (!expected) return env.isProd ? undefined : { token: "dev-open", clientId: "dev", scopes: [] };
  if (bearer && eq(bearer, expected)) return { token: bearer, clientId: "bidbox-client", scopes: [] };
  // Opt-in for connectors that only accept a URL: https://.../api/mcp?token=... (tokens in URLs can leak into logs; rotate if shared).
  if (process.env.MCP_ALLOW_URL_TOKEN === "true") {
    const t = new URL(req.url).searchParams.get("token");
    if (t && eq(t, expected)) return { token: t, clientId: "bidbox-url-token", scopes: [] };
  }
  return undefined;
}, { required: true });

// A browser opening this URL is not an MCP client. Explain instead of showing a bare auth error.
const guarded = async (req: Request) => {
  const accept = req.headers.get("accept") || "";
  if (req.method === "GET" && !req.headers.get("authorization") && accept.includes("text/html")) {
    return Response.json({
      service: "bid-box MCP server", protocol: "MCP over Streamable HTTP",
      message: "This endpoint is for MCP clients, not browsers. Send POST requests with header 'Authorization: Bearer <MCP_AUTH_TOKEN>'.",
      test: "Open the Bid Box dashboard and press 'Test MCP' for a one-click handshake.", tools: ["load_tender", "ingest_bid", "compare_bid", "verify_evidence", "generate_committee_file", "log_action", "search_procurements"],
    });
  }
  return (authed as any)(req);
};

export { guarded as GET, guarded as POST, guarded as DELETE };
