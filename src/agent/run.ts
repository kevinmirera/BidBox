import { q, json } from "../lib/db";
import { env, resolveMcpUrl } from "../lib/env";
import { buildGraph } from "./graph";
import type { ToolEvent } from "./loop";
import { McpConnection } from "./mcp-client";
import { connectExternal } from "./external";
import type { ModelProvider } from "./provider";

export type RunOptions = { tenderRef: string; provider: ModelProvider; runId?: string; batchSize?: number; maxRecovery?: number; mcpUrl?: string; mcpToken?: string };

/**
 * Executes (or resumes) the LangGraph workflow. State is persisted to agent_runs.graph_state so a run can
 * be continued in later invocations - serverless functions have time limits, so a run is processed in
 * batches of bids rather than one unbounded request.
 */
export async function runAgent(o: RunOptions) {
  const url = o.mcpUrl ?? resolveMcpUrl(); const token = o.mcpToken ?? env.mcpAuthToken ?? undefined;
  let runId = o.runId; let prior: any = null;
  const tenderRow = (await q(`SELECT id FROM tenders WHERE ref=$1`, [o.tenderRef]))[0];
  if (!tenderRow) throw new Error(`tender not found: ${o.tenderRef}`);
  if (runId) { prior = (await q(`SELECT graph_state, status FROM agent_runs WHERE id=$1`, [runId]))[0]; if (!prior) throw new Error("run not found"); if (prior.status === "AGENT_ANALYSIS_COMPLETE") throw new Error("run already complete"); }
  else runId = (await q(`INSERT INTO agent_runs (tender_id, provider, model) VALUES ($1,$2,$3) RETURNING id`, [tenderRow.id, o.provider.id, o.provider.model]))[0].id as string;

  const pool = new Map<string, McpConnection>();
  const connFor = async (actor: string) => {
    if (!pool.has(actor)) pool.set(actor, await new McpConnection("bidbox", url, { token: token || undefined, headers: { "x-bidbox-run-id": runId!, "x-bidbox-actor": actor } }).connect());
    return pool.get(actor)!;
  };
  const events: ToolEvent[] = [];
  let external: Awaited<ReturnType<typeof connectExternal>> = null;
  try {
    const bidBox = await connFor(o.provider.actor);
    const tools = await bidBox.listTools();
    try { external = await connectExternal(runId!); } catch (e: any) { events.push({ at: new Date().toISOString(), node: "startup", bid: null, reasoning: "", tool: "external_mcp_connect", args: {}, status: "ERROR", summary: `external MCP server unavailable, continuing without it: ${e.message}` }); }
    const graph = buildGraph({ provider: o.provider, connFor, bidBox, tools, onEvent: (e) => events.push(e), batchSize: o.batchSize ?? 3, maxRecovery: o.maxRecovery ?? 1, external });
    const init = prior?.graph_state?.state ? { ...prior.graph_state.state, processed_this_invocation: 0, status: "RUNNING" } : { tender_id: o.tenderRef, run_id: runId };
    const out: any = await graph.invoke(init, { recursionLimit: 400 });
    const allEvents = [...(prior?.graph_state?.events ?? []), ...events];
    const status = out.status === "AGENT ANALYSIS COMPLETE" ? "AGENT_ANALYSIS_COMPLETE" : out.status === "AGENT ANALYSIS INCOMPLETE" ? "AGENT_ANALYSIS_INCOMPLETE" : out.status === "FAILED" ? "FAILED" : "RUNNING";
    await q(`UPDATE agent_runs SET graph_state=$1::jsonb, status=$2, finished_at=${status === "RUNNING" ? "NULL" : "now()"} WHERE id=$3`, [json({ state: out, events: allEvents }), status, runId]);
    return { run_id: runId, status: out.status, processed: out.current_index, total: out.bid_ids.length, human_review_required: out.human_review_required, human_flags: out.human_flags, errors: out.errors, committee_file: out.committee_file, node_trace_tail: out.node_trace.slice(-12), tool_events: events.length };
  } finally { for (const c of pool.values()) await c.close(); if (external) await external.conn.close(); }
}
