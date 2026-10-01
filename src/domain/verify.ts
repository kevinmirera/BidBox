import { q, json } from "../lib/db";
import { bidDocs } from "./repo";
import { buildReference, deviation, exceeds } from "./calibration";
import { clip, documentIssue, normName, scan, sectionOf, srcOf, type DocRow, type Source } from "./extract";

export const INSUFFICIENT = "Insufficient evidence - requires human review.";
/** Everything quoted from a supplier document is wrapped so downstream models treat it as data, never instructions. */
export const untrusted = (s: string) => `<untrusted_supplier_document_excerpt>${s}</untrusted_supplier_document_excerpt>`;

type Result = {
  verified: boolean; outcome: string; status: "CONFIRMED" | "RESOLVED" | "EVIDENCE_MISSING" | "CONTRADICTED";
  sources: (Source | { kind: "ABSENCE_AFTER_SEARCH"; documents_searched: { document: string; pages: number; readable: boolean }[] })[];
  confidence: number; contradictions: string[]; note?: string;
};

/** Assert an excerpt really occurs on the cited page (prevents invented citations). */
function excerptExists(docs: DocRow[], s: Source) {
  const d = docs.find((x) => x.id === s.document_id);
  const pg = d?.pages?.find((p) => p.page === s.page);
  return !!pg && pg.text.includes(s.excerpt.replace(/…$/, "").replace(/ \| /g, "\n").split("\n")[0]);
}

export async function verifyFinding(tender: any, bid: any, findingId: string, cal: any) {
  const rows = await q(`SELECT * FROM investigations WHERE id=$1 AND bid_id=$2`, [findingId, bid.id]);
  const f = rows[0];
  if (!f) throw new Error(`finding not found for this bid: ${findingId}`);
  const docs = await bidDocs(bid.id);
  const ing = bid.ingested;
  const res = await run(f, tender, bid, docs, ing, cal);

  // Never claim "verified" without a source that actually exists in the stored document text.
  const concrete = res.sources.filter((s: any) => !("kind" in s)) as Source[];
  if (res.verified && !res.sources.length) { res.verified = false; res.status = "EVIDENCE_MISSING"; res.note = INSUFFICIENT; }
  for (const s of concrete) if (!excerptExists(docs, s)) { res.verified = false; res.status = "EVIDENCE_MISSING"; res.note = INSUFFICIENT; }

  const statusDb = res.status === "CONFIRMED" ? "CONFIRMED" : res.status;
  const needsHuman = res.status === "EVIDENCE_MISSING" || res.status === "CONTRADICTED";
  const out = {
    finding: { finding_id: f.id, kind: f.kind, description: f.description, severity: f.severity },
    verified: res.verified, outcome: res.outcome, status: statusDb,
    source: concrete[0] ? { document: concrete[0].document, page: concrete[0].page, section: concrete[0].section } : (res.sources[0] ?? null),
    sources: res.sources.map((s: any) => ("kind" in s ? s : { document: s.document, page: s.page, section: s.section })),
    source_excerpt: concrete[0] ? untrusted(concrete[0].excerpt) : null,
    all_excerpts: concrete.map((s) => ({ document: s.document, page: s.page, section: s.section, excerpt: untrusted(s.excerpt) })),
    evidence_confidence: res.confidence, contradictions: res.contradictions,
    requires_human_review: needsHuman || f.kind === "INJECTION_ATTEMPT",
    note: res.note ?? (needsHuman ? INSUFFICIENT : undefined),
    reminder: "Verification confirms what the document says. It is not a judgement on the bid and no award decision is made by Bid Box.",
  };
  await q(`UPDATE investigations SET status=$1, verification=$2::jsonb, updated_at=now() WHERE id=$3`, [statusDb, json(out), f.id]);
  const evStatus = res.status === "CONFIRMED" || res.status === "RESOLVED" ? "VERIFIED" : res.status;
  for (const eid of f.evidence_ids ?? []) await q(`UPDATE evidence SET status=$1 WHERE id=$2`, [evStatus, eid]);
  return out;
}

async function run(f: any, tender: any, bid: any, docs: DocRow[], ing: any, cal: any): Promise<Result> {
  const req = tender.requirements;
  const searched = docs.map((d) => ({ document: d.name, pages: d.pages?.length ?? 0, readable: !documentIssue(d) }));
  const absence = (): Result["sources"] => [{ kind: "ABSENCE_AFTER_SEARCH", documents_searched: searched }];

  switch (f.kind) {
    case "PRICE_DEVIATION":
    case "PRICE_ABOVE_CEILING": {
      const hit = scan(docs, /^Total Price:/i)[0];
      if (!hit) return { verified: false, outcome: "PRICE_NOT_FOUND_IN_SOURCE", status: "EVIDENCE_MISSING", sources: [], confidence: 0, contradictions: [] };
      // Look on the SAME page for a currency declaration the extractor did not associate with the price.
      const note = hit.page.text.split("\n").map((l) => l.trim().match(/^All amounts in ([A-Z]{3})/i)).find(Boolean);
      const stated = ing.price.currency_assumed && note ? note[1].toUpperCase() : ing.price.currency;
      const fx = req.financial?.fx_reference ?? {};
      const tcur = req.financial?.currency;
      const usd = stated === tcur ? ing.price.amount : fx[stated] ? ing.price.amount / fx[stated] : null;
      const srcs = [srcOf(hit)];
      if (note) { const l = scan(docs, /^All amounts in [A-Z]{3}/i)[0]; if (l) srcs.push(srcOf(l)); }
      if (usd == null) return { verified: false, outcome: "CANNOT_NORMALISE_CURRENCY", status: "EVIDENCE_MISSING", sources: srcs, confidence: 0.3, contradictions: [`currency ${stated} has no tender reference rate`], note: INSUFFICIENT };
      const dv = deviation(usd, cal.reference.price_usd);
      const still = f.kind === "PRICE_ABOVE_CEILING" ? usd > (req.financial?.budget_ceiling ?? Infinity) : exceeds(dv);
      return still
        ? { verified: true, outcome: "ANOMALY_CONFIRMED_IN_SOURCE", status: "CONFIRMED", sources: srcs, confidence: 0.95, contradictions: [], note: `Price confirmed at ${usd} ${tcur}-equivalent (${dv ? (dv.deviation_pct * 100).toFixed(1) + "% vs reference median" : "no reference"}).` }
        : { verified: true, outcome: "ANOMALY_NOT_SUPPORTED_AFTER_CURRENCY_CHECK", status: "RESOLVED", sources: srcs, confidence: 0.9, contradictions: [], note: `The page declares amounts in ${stated}; converted at the tender reference rate (${fx[stated]}), the price is ${Math.round(usd)} ${tcur}, within the reference range. Original flag was an extraction artefact.` };
    }
    case "DELIVERY_DEVIATION": {
      const hits = scan(docs, /^Delivery Period:/i);
      return hits.length ? { verified: true, outcome: "DEVIATION_CONFIRMED_IN_SOURCE", status: "CONFIRMED", sources: hits.map(srcOf), confidence: 0.9, contradictions: [] } : { verified: false, outcome: "NOT_FOUND", status: "EVIDENCE_MISSING", sources: [], confidence: 0, contradictions: [] };
    }
    case "CONTRADICTORY_DELIVERY":
    case "DELIVERY_REQUIREMENT_FAILURE": {
      const hits = scan(docs, /^Delivery Period:\s*(\d+)/i);
      const days = [...new Set(hits.map((h) => h.groups[1]))];
      return { verified: hits.length > 0, outcome: days.length > 1 ? "CONTRADICTION_CONFIRMED" : "STATED_ONCE", status: days.length > 1 ? "CONTRADICTED" : "CONFIRMED", sources: hits.map(srcOf), confidence: 0.95, contradictions: days.length > 1 ? hits.map((h) => `${h.doc.name} p${h.page.page}: ${h.groups[1]} days`) : [] };
    }
    case "TECHNICAL_MISMATCH": {
      const srcs: Source[] = [];
      for (const r of req.technical) { const s = ing.technical_specifications[r.key]; if (s?.source && s.value != null) { const ok = r.op === ">=" ? s.value >= r.value : s.value <= r.value; if (!ok) srcs.push(s.source); } }
      return srcs.length ? { verified: true, outcome: "MISMATCH_CONFIRMED_IN_SOURCE", status: "CONFIRMED", sources: srcs, confidence: 0.95, contradictions: [] } : { verified: false, outcome: "NOT_REPRODUCED", status: "EVIDENCE_MISSING", sources: [], confidence: 0.2, contradictions: [] };
    }
    case "MISSING_DOCUMENT": {
      const missing: string[] = f.trigger?.missing ?? [];
      const found = docs.some((d) => !documentIssue(d) && d.pages!.some((p) => missing.some((k) => new RegExp(k.replace("_", "[ _]"), "i").test(sectionOf(p)))));
      return found ? { verified: false, outcome: "DOCUMENT_FOUND_ON_RECHECK", status: "RESOLVED", sources: [], confidence: 0.6, contradictions: ["document located on re-check"], note: INSUFFICIENT } : { verified: true, outcome: "ABSENCE_CONFIRMED", status: "CONFIRMED", sources: absence(), confidence: 0.9, contradictions: [], note: "Absence established by searching all submitted documents (listed in sources)." };
    }
    case "UNREADABLE_DOCUMENT": {
      const bad = docs.filter((d) => documentIssue(d));
      return bad.length ? { verified: true, outcome: "UNREADABLE_CONFIRMED", status: "CONFIRMED", sources: bad.map((d) => ({ kind: "ABSENCE_AFTER_SEARCH" as const, documents_searched: [{ document: d.name, pages: 0, readable: false }] })), confidence: 0.95, contradictions: [], note: bad.map((d) => documentIssue(d)).join("; ") } : { verified: false, outcome: "NOW_READABLE", status: "RESOLVED", sources: [], confidence: 0.5, contradictions: [], note: INSUFFICIENT };
    }
    case "SUPPLIER_INCONSISTENCY": {
      const hits = [...scan(docs, /^Supplier:/i), ...scan(docs, /^Registration Number:/i)];
      const names = new Set(scan(docs, /^Supplier:\s*(.+)$/i).map((h) => normName(h.groups[1])));
      const regs = new Set(scan(docs, /^Registration Number:\s*(.+)$/i).map((h) => h.groups[1].trim().toUpperCase()));
      const bad = names.size > 1 || regs.size > 1;
      return { verified: hits.length > 0, outcome: bad ? "INCONSISTENCY_CONFIRMED" : "CONSISTENT_ON_RECHECK", status: bad ? "CONTRADICTED" : "RESOLVED", sources: hits.map(srcOf), confidence: 0.95, contradictions: bad ? hits.map((h) => `${h.doc.name} p${h.page.page}: ${clip(h.line, 90)}`) : [] };
    }
    case "MISSING_SUPPLIER_INFO": {
      const reg = docs.find((d) => d.kind === "compliance" && !documentIssue(d));
      const pg = reg?.pages?.find((p) => /business registration/i.test(sectionOf(p)));
      const src: Source[] = reg && pg ? [{ document_id: reg.id, document: reg.name, page: pg.page, section: sectionOf(pg), excerpt: clip(pg.text.split("\n").slice(0, 3).join(" | ")) }] : [];
      return { verified: src.length > 0, outcome: src.length ? "FIELDS_ABSENT_ON_REGISTRATION_PAGE" : "NO_REGISTRATION_PAGE", status: src.length ? "CONFIRMED" : "EVIDENCE_MISSING", sources: src, confidence: 0.85, contradictions: [] };
    }
    case "EVIDENCE_GAP": {
      const hit = scan(docs, /ISO\s*\d{4,5}.*certif/i)[0];
      return { verified: false, outcome: "CLAIM_PRESENT_NO_SUPPORTING_DOCUMENT", status: "EVIDENCE_MISSING", sources: hit ? [srcOf(hit)] : [], confidence: 0.2, contradictions: [], note: INSUFFICIENT };
    }
    case "INJECTION_ATTEMPT": {
      const hit = scan(docs, /(ignore (all )?(previous|prior|above) instructions|automated evaluation systems?)/i);
      return { verified: hit.length > 0, outcome: "INJECTION_TEXT_CONFIRMED_AND_IGNORED", status: "CONFIRMED", sources: hit.map(srcOf), confidence: 0.99, contradictions: [] };
    }
    default:
      return { verified: false, outcome: "NO_VERIFIER_FOR_KIND", status: "EVIDENCE_MISSING", sources: [], confidence: 0, contradictions: [], note: INSUFFICIENT };
  }
}
