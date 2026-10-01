import { cmp, normName, type Ingest, type Source } from "./extract";
import { deviation, exceeds, type Reference } from "./calibration";

export type Trigger = {
  kind: string;
  severity: "info" | "low" | "medium" | "high";
  description: string;
  detail: Record<string, unknown>;
  sources: Source[];
};

/** Kinds that are objective facts about the submission (not statistical deviations). */
export const FACT_KINDS = new Set([
  "MISSING_DOCUMENT", "UNREADABLE_DOCUMENT", "TECHNICAL_MISMATCH", "MISSING_SUPPLIER_INFO", "SUPPLIER_INCONSISTENCY",
  "CONTRADICTORY_DELIVERY", "DELIVERY_REQUIREMENT_FAILURE", "EVIDENCE_GAP", "INJECTION_ATTEMPT", "PRICE_ABOVE_CEILING",
]);

/**
 * Produce investigation triggers. A trigger means "investigate this", never "reject" and never "prefer".
 * Calibration-set bids only get factual checks; statistical deviation checks are suppressed for them
 * because they are the data that DEFINE the reference.
 */
export function evaluateBid(ing: Ingest, req: any, ref: Reference, role: "CALIBRATION" | "SEQUENTIAL", refReady: boolean) {
  const t: Trigger[] = [];
  const suppressed: string[] = [];

  // --- factual checks -------------------------------------------------------
  const missingDocs = Object.entries(ing.mandatory_documents).filter(([, v]) => !v.present && v.reason === "NOT_FOUND");
  if (missingDocs.length) t.push({ kind: "MISSING_DOCUMENT", severity: "high", description: `Mandatory document(s) not found in submission: ${missingDocs.map(([k]) => k).join(", ")}`, detail: { missing: missingDocs.map(([k]) => k) }, sources: [] });

  if (ing.parse_issues.length) t.push({ kind: "UNREADABLE_DOCUMENT", severity: "high", description: `Document(s) could not be read: ${ing.parse_issues.join("; ")}`, detail: { issues: ing.parse_issues }, sources: [] });

  const mism: string[] = []; const msrc: Source[] = [];
  for (const r of req.technical ?? []) {
    const s = ing.technical_specifications[r.key];
    if (s?.value != null && !cmp(s.value, r.op, r.value)) { mism.push(`${r.label}: offered ${s.value}, required ${r.op} ${r.value}`); if (s.source) msrc.push(s.source); }
  }
  if (mism.length) t.push({ kind: "TECHNICAL_MISMATCH", severity: "high", description: `Technical requirement not met - ${mism.join("; ")}`, detail: { mismatches: mism }, sources: msrc });

  const missingSup = (req.mandatory?.supplier_fields ?? []).filter((f: string) => ing.missing_information.some((m) => m.endsWith(f)));
  if (missingSup.length) t.push({ kind: "MISSING_SUPPLIER_INFO", severity: "medium", description: `Required supplier information not found: ${missingSup.join(", ")}`, detail: { fields: missingSup }, sources: [] });

  const nameSet = new Set(ing.supplier.name_variants.map((v) => normName(v.value)));
  const regSet = new Set(ing.supplier.registration_variants.map((v) => v.value.trim().toUpperCase()));
  if (nameSet.size > 1 || regSet.size > 1) {
    t.push({ kind: "SUPPLIER_INCONSISTENCY", severity: "high",
      description: `Supplier identity differs between documents (names: ${[...new Set(ing.supplier.name_variants.map((v) => v.value))].join(" / ")}; registration numbers: ${[...regSet].join(" / ") || "n/a"})`,
      detail: { names: ing.supplier.name_variants.map((v) => v.value), registrations: [...regSet] },
      sources: [...ing.supplier.name_variants, ...ing.supplier.registration_variants].map((v) => v.source) });
  }

  const days = new Set(ing.delivery.candidates.map((c) => c.days));
  if (days.size > 1) t.push({ kind: "CONTRADICTORY_DELIVERY", severity: "high", description: `Delivery period stated inconsistently: ${[...days].join(" vs ")} days`, detail: { candidates: [...days] }, sources: ing.delivery.candidates.map((c) => c.source) });
  const maxDays = req.delivery?.max_days;
  if (maxDays && ing.delivery.candidates.some((c) => c.days > maxDays)) {
    const over = ing.delivery.candidates.filter((c) => c.days > maxDays);
    t.push({ kind: "DELIVERY_REQUIREMENT_FAILURE", severity: "high", description: `Delivery period exceeds tender maximum of ${maxDays} days (stated: ${over.map((c) => c.days).join(", ")})`, detail: { max_days: maxDays, stated: over.map((c) => c.days) }, sources: over.map((c) => c.source) });
  }

  for (const u of ing.unsupported_claims) t.push({ kind: "EVIDENCE_GAP", severity: "medium", description: `${u.claim} but no supporting document found (${u.needs})`, detail: { needs: u.needs }, sources: [u.source] });
  if (ing.injection_flags.length) t.push({ kind: "INJECTION_ATTEMPT", severity: "high", description: "Supplier document contains text addressed to automated evaluators (possible prompt injection). Treated as untrusted data; ignored.", detail: { occurrences: ing.injection_flags.length }, sources: ing.injection_flags });

  const ceiling = req.financial?.budget_ceiling;
  if (ceiling && ing.price.price_usd != null && ing.price.price_usd > ceiling && !ing.price.currency_assumed)
    t.push({ kind: "PRICE_ABOVE_CEILING", severity: "high", description: `Total price ${ing.price.price_usd} exceeds budget ceiling ${ceiling}`, detail: { price_usd: ing.price.price_usd, ceiling }, sources: ing.price.source ? [ing.price.source] : [] });

  // --- statistical deviation checks (sequential bids only) ---------------------
  let priceDev = null, delDev = null;
  if (ing.metrics.price_usd != null) priceDev = deviation(ing.metrics.price_usd, ref.price_usd);
  if (ing.metrics.delivery_days != null) delDev = deviation(ing.metrics.delivery_days, ref.delivery_days);
  if (role === "CALIBRATION" || !refReady) {
    suppressed.push(role === "CALIBRATION" ? "deviation checks suppressed: this bid is part of the calibration/reference set" : "deviation checks suppressed: no reference available yet");
  } else {
    if (exceeds(priceDev)) t.push({ kind: "PRICE_DEVIATION", severity: Math.abs(priceDev!.robust_z) > 5 ? "high" : "medium",
      description: `Total price is ${(priceDev!.deviation_pct * 100).toFixed(1)}% ${priceDev!.deviation_pct > 0 ? "above" : "below"} the calibration reference median (robust z=${priceDev!.robust_z})${ing.price.currency_assumed ? "; NOTE currency was assumed, not stated" : ""}`,
      detail: { ...priceDev, currency_assumed: ing.price.currency_assumed }, sources: ing.price.source ? [ing.price.source] : [] });
    if (exceeds(delDev)) t.push({ kind: "DELIVERY_DEVIATION", severity: "low",
      description: `Delivery period is ${(delDev!.deviation_pct * 100).toFixed(1)}% ${delDev!.deviation_pct > 0 ? "above" : "below"} the calibration reference median (robust z=${delDev!.robust_z})`,
      detail: { ...delDev }, sources: ing.delivery.candidates.slice(0, 1).map((c) => c.source) });
  }
  return { triggers: t, price_deviation: priceDev, delivery_deviation: delDev, suppressed };
}
