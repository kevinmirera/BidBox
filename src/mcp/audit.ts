import crypto from "node:crypto";
import { q, json } from "../lib/db";
import { canon } from "../lib/canon";

export type Ctx = { runId: string | null; actor: string | null };
export type ToolOutcome = { data: unknown; status?: "SUCCESS" | "FLAGGED"; humanApproval?: string };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const norm = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export async function appendAudit(r0: {
  run_id: string | null; tender_id: string | null; bid_id: string | null; tool_name: string; input: unknown; output: unknown;
  status: string; error?: string | null; actor: string | null; human_approval?: string; started_at: Date; duration_ms: number;
}) {
  // Normalise through JSON first (Dates -> ISO strings, undefined dropped) so what we hash is exactly what Postgres stores.
  const r = { ...r0, input: norm(r0.input), output: norm(r0.output) };
  const key = r.run_id ?? "unattributed";
  const last = await q(`SELECT row_hash FROM tool_calls WHERE COALESCE(run_id,'unattributed')=$1 ORDER BY id DESC LIMIT 1`, [key]);
  const prev = last[0]?.row_hash ?? null;
  const payload = canon([prev, r.run_id, r.tender_id, r.bid_id, r.tool_name, r.input, r.output, r.status, r.error ?? null, r.actor, r.started_at.toISOString(), r.duration_ms]);
  const row_hash = sha(payload);
  const rows = await q(
    `INSERT INTO tool_calls (run_id,tender_id,bid_id,tool_name,input,output,status,error,actor,human_approval,started_at,duration_ms,prev_hash,row_hash)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, started_at`,
    [r.run_id, r.tender_id, r.bid_id, r.tool_name, json(r.input), json(r.output), r.status, r.error ?? null, r.actor, r.human_approval ?? "NONE_REQUIRED", r.started_at.toISOString(), r.duration_ms, prev, row_hash],
  );
  return { audit_id: Number(rows[0].id), timestamp: new Date(rows[0].started_at).toISOString(), status: r.status };
}

/** Recompute the hash chain for a run; returns whether it is intact. */
export async function verifyChain(runId: string) {
  const rows = await q(`SELECT * FROM tool_calls WHERE COALESCE(run_id,'unattributed')=$1 ORDER BY id`, [runId]);
  let prev: string | null = null;
  for (const r of rows) {
    const payload = canon([prev, r.run_id, r.tender_id, r.bid_id, r.tool_name, r.input, r.output, r.status, r.error ?? null, r.actor, new Date(r.started_at).toISOString(), r.duration_ms]);
    if (r.prev_hash !== prev || sha(payload) !== r.row_hash) return { intact: false, broken_at_audit_id: Number(r.id), records: rows.length };
    prev = r.row_hash;
  }
  return { intact: true, records: rows.length };
}

class ToolTimeout extends Error {}
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 25000);

/**
 * Wrap a tool handler so EVERY invocation is audited automatically (success, flagged, validation
 * failure or exception). The model cannot skip, edit or delete these records: it has no tool that
 * writes to this path with its own content, and the table rejects UPDATE/DELETE (DB trigger).
 */
export function withAudit<A extends Record<string, any>>(toolName: string, handler: (args: A, ctx: Ctx) => Promise<ToolOutcome>) {
  return async (args: A, ctx: Ctx) => {
    const started = new Date(); const t0 = Date.now();
    let status = "SUCCESS", error: string | null = null, data: any, approval: string | undefined;
    try {
      const out = await Promise.race([handler(args, ctx), new Promise<never>((_, rej) => setTimeout(() => rej(new ToolTimeout(`tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS))]);
      data = out.data; status = out.status ?? "SUCCESS"; approval = out.humanApproval;
    } catch (e: any) {
      status = "ERROR"; error = e?.message ?? String(e);
      data = { error: { code: e?.constructor?.name ?? "Error", message: error, recoverable: !(e instanceof ToolTimeout) ? e?.constructor?.name !== "NotFound" : true } };
    }
    let audit: any = null;
    try {
      audit = await appendAudit({ run_id: ctx.runId, tender_id: args?.tender_id ?? null, bid_id: args?.bid_id ?? null, tool_name: toolName, input: args, output: data, status, error, actor: ctx.actor, human_approval: approval, started_at: started, duration_ms: Date.now() - t0 });
    } catch (e: any) {
      // Audit failure is itself surfaced: a tool result without an audit record must not look normal.
      status = "ERROR"; data = { error: { code: "AuditFailure", message: `audit write failed: ${e.message}`, recoverable: false } };
    }
    return { data, status, error, audit };
  };
}
