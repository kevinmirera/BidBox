import { NextResponse } from "next/server";
import { adminAuth } from "../../../lib/auth";
import { env, resolveMcpUrl } from "../../../lib/env";
import { McpConnection } from "../../../agent/mcp-client";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Browser-friendly MCP self-test: performs a real MCP handshake + tools/list against this app's own endpoint. */
export async function POST(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const url = resolveMcpUrl(); const t0 = Date.now();
  const conn = new McpConnection("selftest", url, { token: env.mcpAuthToken || undefined, timeoutMs: 15000 });
  try {
    await conn.connect();
    const tools = await conn.listTools();
    const lt = await conn.callTool("load_tender", { tender_id: "TND-2026-014" });
    return NextResponse.json({ ok: true, url, ms: Date.now() - t0, tools: tools.map((t) => t.name), sample_call: { tool: "load_tender", ok: !lt.isError, note: lt.isError ? lt.data?.error?.message : "returned tender data" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, url, error: e?.message ?? String(e), hint: "If the URL is a *.vercel.app deployment URL behind Vercel Authentication, set MCP_SERVER_URL to your production domain." }, { status: 502 });
  } finally { await conn.close(); }
}
