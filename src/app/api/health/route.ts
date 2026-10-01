import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import { resolveMcpUrl } from "../../../lib/env";
import { TOOL_NAMES } from "../../../mcp/server";

export const runtime = "nodejs";
export async function GET() {
  let db = "unknown";
  try { const d = await getDb(); await d.query("SELECT 1"); db = d.kind; } catch (e: any) { db = `error: ${e.message}`; }
  return NextResponse.json({ ok: !db.startsWith("error"), service: "bid-box", database: db, mcp_endpoint: resolveMcpUrl(), mcp_tools: TOOL_NAMES, award_tool_present: false });
}
