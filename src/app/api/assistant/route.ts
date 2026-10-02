import { NextResponse } from "next/server";
import { z } from "zod";
import { adminAuth } from "../../../lib/auth";
import { env, resolveMcpUrl } from "../../../lib/env";
import { agentLoop, type ToolEvent } from "../../../agent/loop";
import { McpConnection } from "../../../agent/mcp-client";
import { createProvider } from "../../../agent/providers";
import { ScriptedProvider } from "../../../agent/testing";
import { ASSISTANT_PROMPT, ASSISTANT_SYSTEM } from "../../../agent/prompts";
import { searchProcurements } from "../../../domain/market";

export const runtime = "nodejs";
export const maxDuration = 60;
const Body = z.object({ query: z.string().min(2).max(300), provider: z.enum(["claude", "openai", "openweights", "scripted"]) });

/**
 * Model-driven search assistant: the chosen model decides how to call the Bid Box MCP tool(s) and then summarises.
 * The structured results returned to the UI come from the tool call itself, not from the model's text.
 */
export async function POST(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  if (p.data.provider === "scripted" && env.isProd) return NextResponse.json({ error: "test provider disabled in production" }, { status: 400 });
  const runId = `assistant-${Date.now()}`;
  const holder: { conn: McpConnection | null } = { conn: null };
  try {
    const provider = p.data.provider === "scripted" ? new ScriptedProvider() : createProvider(p.data.provider);
    const connFor = async (actor: string) => (holder.conn ??= await new McpConnection("assistant", resolveMcpUrl(), { token: env.mcpAuthToken || undefined, headers: { "x-bidbox-run-id": runId, "x-bidbox-actor": actor }, timeoutMs: 30000 }).connect());
    const c = await connFor(provider.actor); const tools = await c.listTools();
    const events: ToolEvent[] = []; let structured: any = null;
    const r = await agentLoop({ provider, connFor, node: "assistant", bid: null, system: ASSISTANT_SYSTEM, user: ASSISTANT_PROMPT(p.data.query), allowed: ["search_procurements", "read_resource"], maxSteps: 5, mcpTools: tools, onEvent: (e) => events.push(e) });
    const call = events.find((e) => e.tool === "search_procurements" && e.status !== "ERROR");
    if (call) { try { structured = await searchProcurements(call.args as any); } catch { structured = null; } }
    return NextResponse.json({ answer: r.finalText, model: provider.actor, events, results: structured, errors: r.errors });
  } catch (e: any) {
    const nc = e?.kind === "not_configured";
    return NextResponse.json({ error: e?.message ?? "assistant failed", code: nc ? "PROVIDER_NOT_CONFIGURED" : "ASSISTANT_FAILED" }, { status: nc ? 424 : 500 });
  } finally { await holder.conn?.close(); }
}
