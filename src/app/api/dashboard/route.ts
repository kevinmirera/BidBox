import { NextResponse } from "next/server";
import { adminAuth } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { calibrationState, getTender } from "../../../domain/repo";
import { verifyChain } from "../../../mcp/audit";
import { resolveMcpUrl } from "../../../lib/env";
import { SCENARIOS } from "../../../demo/data";

export const runtime = "nodejs";
export async function GET(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const ref = new URL(req.url).searchParams.get("tender") || "TND-2026-014";
  try {
    const t = await getTender(ref);
    const cal = await calibrationState(t.id);
    const bids = await q(`SELECT id, ref, seq, supplier_hint, status, ingested FROM bids WHERE tender_id=$1 ORDER BY seq`, [t.id]);
    const findings = await q(`SELECT i.id, b.ref AS bid, i.kind, i.severity, i.description, i.status, i.verification, i.evidence_ids FROM investigations i JOIN bids b ON b.id=i.bid_id WHERE i.tender_id=$1 ORDER BY b.seq, i.kind`, [t.id]);
    const evidence = await q(`SELECT e.id, b.ref AS bid, d.name AS document, e.page, e.section, e.excerpt, e.field, e.status, e.confidence FROM evidence e JOIN bids b ON b.id=e.bid_id LEFT JOIN documents d ON d.id=e.document_id WHERE e.tender_id=$1 ORDER BY b.seq`, [t.id]);
    const run = (await q(`SELECT id, provider, model, status, started_at, finished_at, graph_state FROM agent_runs WHERE tender_id=$1 ORDER BY started_at DESC LIMIT 1`, [t.id]))[0] ?? null;
    const calls = await q(`SELECT id, run_id, tool_name, bid_id, status, actor, started_at, duration_ms, input, output, error FROM tool_calls WHERE tender_id=$1 ORDER BY id DESC LIMIT 200`, [t.ref]);
    const evaluation = (await q(`SELECT id, review_status, award_decisions_made, package, created_at FROM evaluations WHERE tender_id=$1 ORDER BY created_at DESC LIMIT 1`, [t.id]))[0] ?? null;
    const approvals = await q(`SELECT id, evaluation_id, action, status, approver, note, created_at FROM human_approvals WHERE tender_id=$1 ORDER BY created_at`, [t.id]);
    const chain = run ? await verifyChain(run.id) : null;
    const gs = run?.graph_state ?? {};
    return NextResponse.json({
      mcp_endpoint: resolveMcpUrl(),
      tender: { ref: t.ref, title: t.title },
      scenarios: Object.fromEntries(SCENARIOS.map((s) => [s.ref, s.scenario])),
      calibration: { size: cal.calibration_size, total: cal.total_bids, ingested: cal.ingested_in_set, phase: cal.phase, stability: Number(cal.stability), version: cal.version, reference: cal.reference },
      bids: bids.map((b: any) => ({ ref: b.ref, seq: b.seq, supplier: b.supplier_hint, status: b.status, role: b.seq <= cal.calibration_size ? "CALIBRATION" : "SEQUENTIAL", metrics: b.ingested?.metrics ?? null, missing: b.ingested?.missing_information ?? [], confidence: b.ingested?.confidence ?? null })),
      findings, evidence, run: run && { id: run.id, provider: run.provider, model: run.model, status: run.status, started_at: run.started_at, finished_at: run.finished_at, plan: gs.state?.plan, human_flags: gs.state?.human_flags ?? [], errors: gs.state?.errors ?? [], events: (gs.events ?? []).slice(-300), node_trace: gs.state?.node_trace ?? [] },
      audit: { chain, calls }, evaluation, approvals,
      counters: { award_decisions_made: 0 },
    });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 404 }); }
}
