import { q, json } from "../lib/db";
import { canon } from "../lib/canon";
import { buildReference, calibrationSize, phaseOf, stability, type Observation } from "./calibration";
import { evaluateBid } from "./analyze";
import { extractBid, type DocRow, type Ingest, type Source } from "./extract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getTender(idOrRef: string) {
  const rows = await q(`SELECT * FROM tenders WHERE ${UUID.test(idOrRef) ? "id" : "ref"} = $1`, [idOrRef]);
  if (!rows[0]) throw new NotFound(`tender not found: ${idOrRef}`);
  return rows[0];
}
export async function getBid(tenderId: string, idOrRef: string) {
  const rows = await q(`SELECT * FROM bids WHERE tender_id = $1 AND ${UUID.test(idOrRef) ? "id" : "ref"} = $2`, [tenderId, idOrRef]);
  if (!rows[0]) throw new NotFound(`bid not found in tender: ${idOrRef}`);
  return rows[0];
}
export class NotFound extends Error {}

export async function bidDocs(bidId: string): Promise<DocRow[]> {
  return q<DocRow>(`SELECT id, name, kind, parse_status, parse_error, pages, size_bytes FROM documents WHERE bid_id = $1 ORDER BY name`, [bidId]);
}

/** Insert (or reuse) an evidence row so findings can point at a stable evidence id. */
export async function ensureEvidence(tenderId: string, bidId: string, field: string, value: unknown, s: Source, confidence: number) {
  const ex = await q(`SELECT id FROM evidence WHERE bid_id=$1 AND field=$2 AND document_id=$3 AND page=$4 AND excerpt=$5`, [bidId, field, s.document_id, s.page, s.excerpt]);
  if (ex[0]) return ex[0].id as string;
  const r = await q(`INSERT INTO evidence (tender_id,bid_id,document_id,field,value,page,section,excerpt,confidence) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id`,
    [tenderId, bidId, s.document_id, field, json(value), s.page, s.section, s.excerpt, confidence]);
  return r[0].id as string;
}

export async function ingestBid(tender: any, bid: any): Promise<Ingest> {
  const docs = await bidDocs(bid.id);
  const ing = extractBid(tender.requirements, docs);
  for (const c of ing.extracted_claims) await ensureEvidence(tender.id, bid.id, c.field, c.value, c.source, c.confidence);
  await q(`UPDATE bids SET ingested=$1::jsonb, status='INGESTED' WHERE id=$2`, [json(ing), bid.id]);
  await refreshCalibration(tender.id);
  return ing;
}

export async function allBids(tenderId: string) {
  return q(`SELECT id, ref, seq, supplier_hint, status, ingested FROM bids WHERE tender_id=$1 ORDER BY seq`, [tenderId]);
}

/** Recompute the calibration reference from ingested bids that belong to the calibration set. */
export async function refreshCalibration(tenderId: string) {
  const bids = await allBids(tenderId);
  const total = bids.length, size = calibrationSize(total);
  const inSet = bids.filter((b: any) => b.seq <= size && b.ingested);
  const obs: Observation[] = inSet.map((b: any) => ({ ref: b.ref, seq: b.seq, ...b.ingested.metrics }));
  const reference = buildReference(obs);
  const stab = stability(obs);
  const phase = phaseOf(obs.length, size, stab);
  const rows = await q(`SELECT version, reference FROM calibration_states WHERE tender_id=$1`, [tenderId]);
  const changed = !rows[0] || canon(rows[0].reference) !== canon(JSON.parse(JSON.stringify(reference)));
  const version = rows[0] ? rows[0].version + (changed ? 1 : 0) : 1;
  await q(`INSERT INTO calibration_states (tender_id,total_bids,calibration_size,ingested_in_set,phase,reference,stability,version)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
           ON CONFLICT (tender_id) DO UPDATE SET total_bids=$2,calibration_size=$3,ingested_in_set=$4,phase=$5,reference=$6::jsonb,stability=$7,version=$8,updated_at=now()`,
    [tenderId, total, size, obs.length, phase, json(reference), stab, version]);
  return { total_bids: total, calibration_size: size, ingested_in_set: obs.length, phase, reference, stability: stab, version, calibration_bid_refs: bids.filter((b: any) => b.seq <= size).map((b: any) => b.ref) };
}
export async function calibrationState(tenderId: string) { await refreshCalibration(tenderId); const r = await q(`SELECT * FROM calibration_states WHERE tender_id=$1`, [tenderId]); return r[0]; }

export async function compareBid(tender: any, bid: any) {
  if (!bid.ingested) throw new NotIngested(`bid ${bid.ref} has not been ingested; call ingest_bid first`);
  const cal = await refreshCalibration(tender.id);
  const role = bid.seq <= cal.calibration_size ? "CALIBRATION" : "SEQUENTIAL";
  const refReady = cal.ingested_in_set > 0 && (cal.phase === "CALIBRATED" || cal.phase === "PROVISIONAL");
  const ev = evaluateBid(bid.ingested, tender.requirements, cal.reference, role, refReady);
  const findings: any[] = [];
  for (const t of ev.triggers) {
    const evIds: string[] = [];
    for (const s of t.sources) evIds.push(await ensureEvidence(tender.id, bid.id, t.kind.toLowerCase(), null, s, 0.9));
    const ex = await q(`SELECT id, status FROM investigations WHERE bid_id=$1 AND kind=$2`, [bid.id, t.kind]);
    let id: string, status: string;
    if (ex[0]) {
      id = ex[0].id; status = ex[0].status;
      if (status === "OPEN") await q(`UPDATE investigations SET description=$1, trigger=$2::jsonb, evidence_ids=$3::jsonb, severity=$4, updated_at=now() WHERE id=$5`, [t.description, json(t.detail), json([...new Set(evIds)]), t.severity, id]);
    } else {
      const r = await q(`INSERT INTO investigations (tender_id,bid_id,kind,severity,description,trigger,evidence_ids) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id, status`, [tender.id, bid.id, t.kind, t.severity, t.description, json(t.detail), json([...new Set(evIds)])]);
      id = r[0].id; status = r[0].status;
    }
    findings.push({ finding_id: id, kind: t.kind, severity: t.severity, description: t.description, status, evidence_count: new Set(evIds).size });
  }
  await q(`UPDATE bids SET status=$1 WHERE id=$2`, [findings.length ? (role === "CALIBRATION" ? "CALIBRATION_FACTS_NOTED" : "INVESTIGATE") : (role === "CALIBRATION" ? "CALIBRATION" : "ANALYSED"), bid.id]);
  return { role, calibration: cal, ev, findings };
}
export class NotIngested extends Error {}
