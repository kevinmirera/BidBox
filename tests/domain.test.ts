import test from "node:test";
import assert from "node:assert/strict";
import { BID_COUNT, TENDER, buildBid } from "../src/demo/data";
import { extractBid, type DocRow } from "../src/domain/extract";
import { buildReference, calibrationSize, phaseOf, stability, type Observation } from "../src/domain/calibration";
import { evaluateBid } from "../src/domain/analyze";

const req = TENDER.requirements;
const docsFor = (i: number): DocRow[] => buildBid(i).docs.map((d, k) => ({ id: `d${i}-${k}`, name: d.name, kind: d.kind, parse_status: d.parse_status, parse_error: d.parse_error ?? null, pages: d.pages, size_bytes: 1000 }));
const ing = Array.from({ length: BID_COUNT }, (_, i) => extractBid(req, docsFor(i)));
const K = calibrationSize(BID_COUNT);
const obs = (i: number): Observation => ({ ref: `BID-${i + 1}`, seq: i + 1, ...ing[i].metrics });
const calib = Array.from({ length: K }, (_, i) => obs(i));
const ref = buildReference(calib);
const kinds = (i: number) => evaluateBid(ing[i], req, ref, i < K ? "CALIBRATION" : "SEQUENTIAL", true).triggers.map((t) => t.kind);

test("calibration size is round(n/e): 20 bids -> 7", () => {
  assert.equal(calibrationSize(20), 7);
  assert.equal(calibrationSize(0), 0);
  assert.equal(calibrationSize(1), 1);
});
test("reference is stable after the calibration set", () => {
  const s = stability(calib);
  assert.ok(s >= 0.8, `stability ${s}`);
  assert.equal(phaseOf(K, K, s), "CALIBRATED");
  assert.equal(phaseOf(0, K, 0), "OBSERVING");
});
test("calibration bids raise no deviation findings and no facts", () => {
  for (let i = 0; i < K; i++) assert.deepEqual(kinds(i), [], `bid ${i + 1}`);
});
test("normal bids raise nothing", () => { for (const i of [8, 15 - 1 + 0, 19]) { if (i === 14) continue; } assert.deepEqual(kinds(8), []); assert.deepEqual(kinds(19), []); });
test("expensive bid (BID-008) flags price deviation ~ +34% and ceiling", () => {
  const k = kinds(7); assert.ok(k.includes("PRICE_DEVIATION")); assert.ok(k.includes("PRICE_ABOVE_CEILING"));
  const dv = evaluateBid(ing[7], req, ref, "SEQUENTIAL", true).price_deviation!;
  assert.ok(Math.abs(dv.deviation_pct - 0.34) < 0.01, String(dv.deviation_pct));
});
test("cheap bid flags price deviation", () => assert.ok(kinds(9).includes("PRICE_DEVIATION")));
test("missing tax clearance", () => assert.ok(kinds(10).includes("MISSING_DOCUMENT")));
test("technical mismatch", () => assert.ok(kinds(11).includes("TECHNICAL_MISMATCH")));
test("supplier inconsistency", () => assert.ok(kinds(12).includes("SUPPLIER_INCONSISTENCY")));
test("malformed pdf -> unreadable, no fabricated specs", () => {
  assert.ok(kinds(13).includes("UNREADABLE_DOCUMENT"));
  assert.equal(ing[13].technical_specifications.ssd_capacity_gb.value, null);
  assert.equal(ing[13].metrics.technical_compliance, null);
});
test("contradictory delivery", () => assert.ok(kinds(14).includes("CONTRADICTORY_DELIVERY")));
test("injection text is flagged, not obeyed", () => assert.ok(kinds(15).includes("INJECTION_ATTEMPT")));
test("unsupported ISO claim -> evidence gap", () => assert.ok(kinds(16).includes("EVIDENCE_GAP")));
test("KES price w/o adjacent currency looks anomalous at ingest (resolved later by verification)", () => {
  assert.equal(ing[17].price.currency_assumed, true);
  assert.ok(kinds(17).includes("PRICE_DEVIATION"));
});
test("incomplete supplier info", () => assert.ok(kinds(18).includes("MISSING_SUPPLIER_INFO")));
test("no output ever contains winner/recommend fields", () => {
  const s = JSON.stringify(ing) + JSON.stringify(kinds(7));
  assert.ok(!/"winner"|best_bid|recommended_supplier/.test(s));
});
