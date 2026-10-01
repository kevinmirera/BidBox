import { q, json } from "../lib/db";
import { verifyChain } from "../mcp/audit";
import { allBids, calibrationState } from "./repo";

export const NO_AWARD_STATEMENT = "NO AWARD DECISION WAS MADE BY BID BOX. Bid Box has no award capability. All findings are investigation aids; the final procurement decision rests exclusively with the human procurement committee.";

export async function buildCommitteePackage(tender: any, runId: string | null) {
  const cal = await calibrationState(tender.id);
  const bids = await allBids(tender.id);
  const inv = await q(`SELECT i.*, b.ref AS bid_ref FROM investigations i JOIN bids b ON b.id=i.bid_id WHERE i.tender_id=$1 ORDER BY b.seq, i.kind`, [tender.id]);
  const evidence = await q(`SELECT e.id, b.ref AS bid_ref, e.field, e.value, d.name AS document, e.page, e.section, e.excerpt, e.confidence, e.status FROM evidence e JOIN bids b ON b.id=e.bid_id LEFT JOIN documents d ON d.id=e.document_id WHERE e.tender_id=$1 ORDER BY b.seq, e.field`, [tender.id]);
  const audit = await q(`SELECT id, run_id, tool_name, tender_id, bid_id, status, actor, started_at, duration_ms FROM tool_calls WHERE tender_id=$1 ORDER BY id`, [tender.ref]);
  const chain = runId ? await verifyChain(runId) : { intact: null, records: 0 };
  const calRefs = new Set(bids.filter((b: any) => b.seq <= cal.calibration_size).map((b: any) => b.ref));

  const findings = inv.map((f: any) => ({
    finding_id: f.id, bid: f.bid_ref, kind: f.kind, severity: f.severity, description: f.description, status: f.status,
    why_flagged: f.trigger, verification: f.verification ? { verified: f.verification.verified, outcome: f.verification.outcome, sources: f.verification.sources, contradictions: f.verification.contradictions, note: f.verification.note } : null,
    evidence_refs: (f.evidence_ids ?? []).map((id: string) => evidence.find((e: any) => e.id === id)).filter(Boolean).map((e: any) => ({ document: e.document, page: e.page, section: e.section, excerpt: e.excerpt, evidence_status: e.status })),
    requires_human_review: !f.verification || ["EVIDENCE_MISSING", "CONTRADICTED", "OPEN"].includes(f.status) || f.kind === "INJECTION_ATTEMPT",
  }));
  const missing = bids.flatMap((b: any) => (b.ingested?.missing_information ?? []).map((m: string) => ({ bid: b.ref, flag: m })));

  return {
    document: "Bid Box Committee Evaluation File",
    statement: NO_AWARD_STATEMENT,
    award_decisions_made: 0,
    final_decision_authority: "HUMAN PROCUREMENT COMMITTEE",
    human_review_status: "COMMITTEE_REVIEW_REQUIRED",
    tender: { ref: tender.ref, title: tender.title, requirements: tender.requirements },
    generated_at: new Date().toISOString(), run_id: runId,
    method_note: "Calibration uses an experimental investigation-allocation heuristic inspired by the secretary problem (first ~1/e of bids form a reference set). It is NOT a procurement rule, scoring formula or ranking. It only decides which findings deserve deeper investigation.",
    summary: {
      bids_total: bids.length, bids_ingested: bids.filter((b: any) => b.ingested).length, calibration_bids: [...calRefs],
      calibration: { size: cal.calibration_size, phase: cal.phase, stability: Number(cal.stability), reference_version: cal.version, reference: cal.reference },
      findings_total: findings.length, findings_needing_human_review: findings.filter((f: any) => f.requires_human_review).length,
      findings_resolved_after_verification: findings.filter((f: any) => f.status === "RESOLVED").length,
      award_decisions_made: 0,
    },
    bids: bids.map((b: any) => ({ bid: b.ref, submission_order: b.seq, supplier_as_submitted: b.supplier_hint, role: calRefs.has(b.ref) ? "CALIBRATION" : "SEQUENTIAL", status: b.status, metrics: b.ingested?.metrics ?? null, ingest_confidence: b.ingested?.confidence ?? null, open_findings: findings.filter((f: any) => f.bid === b.ref).map((f: any) => f.kind) })),
    findings, evidence_references: evidence, missing_data_flags: missing,
    investigation_history: inv.map((f: any) => ({ finding_id: f.id, bid: f.bid_ref, kind: f.kind, opened_at: f.created_at, last_updated: f.updated_at, status: f.status })),
    audit_log: { chain_integrity: chain, records: audit.length, entries: audit },
  };
}

export async function saveEvaluation(tender: any, runId: string | null, pkg: any) {
  const runUuid = runId && /^[0-9a-f-]{36}$/i.test(runId) ? runId : null;
  const r = await q(`INSERT INTO evaluations (tender_id, run_id, package, review_status) VALUES ($1,$2,$3::jsonb,'COMMITTEE_REVIEW_REQUIRED') RETURNING id`, [tender.id, runUuid, json(pkg)]);
  await q(`INSERT INTO human_approvals (tender_id, evaluation_id, action, status) VALUES ($1,$2,'EXPORT_COMMITTEE_FILE','PENDING')`, [tender.id, r[0].id]);
  return r[0].id as string;
}
