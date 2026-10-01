/**
 * Deterministic, provenance-preserving extraction from stored document pages.
 * Supplier documents are UNTRUSTED input: nothing in a document is ever executed or obeyed, and no
 * LLM reads raw documents here. Every extracted value carries document / page / section / excerpt.
 */
export const MAX_DOC_BYTES = 2_000_000;
export const MAX_PAGES = 300;
export const MAX_EXCERPT = 400;

export type Page = { page: number; text: string };
export type DocRow = { id: string; name: string; kind: string; parse_status: string; parse_error: string | null; pages: Page[] | null; size_bytes: number };
export type Source = { document_id: string; document: string; page: number; section: string; excerpt: string };
export type Claim = { field: string; value: unknown; source: Source; confidence: number };

export const INJECTION_RE = /(ignore (all )?(previous|prior|above) instructions|disregard (the )?(system|previous)|system prompt|you are now|recommend (this bid )?for award|mark (every|all) (finding|bid).{0,30}verified|automated evaluation systems?)/i;

export function sectionOf(p: Page): string { return (p.text.split("\n")[0] || "").trim().slice(0, 120); }
export const clip = (s: string, n = MAX_EXCERPT) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Validate a stored document before reading it. Returns an issue string or null. */
export function documentIssue(d: DocRow): string | null {
  if (d.parse_status !== "OK") return `${d.name}: ${d.parse_status}${d.parse_error ? " - " + d.parse_error : ""}`;
  if (!d.pages || !d.pages.length) return `${d.name}: no extractable text`;
  if (d.size_bytes > MAX_DOC_BYTES) return `${d.name}: exceeds maximum size (${MAX_DOC_BYTES} bytes)`;
  if (d.pages.length > MAX_PAGES) return `${d.name}: exceeds maximum page count (${MAX_PAGES})`;
  return null;
}

type Hit = { doc: DocRow; page: Page; line: string; groups: RegExpMatchArray };
export function scan(docs: DocRow[], re: RegExp): Hit[] {
  const out: Hit[] = [];
  for (const doc of docs) {
    if (documentIssue(doc)) continue;
    for (const page of doc.pages!) for (const line of page.text.split("\n")) {
      const m = line.trim().match(re);
      if (m) out.push({ doc, page, line: line.trim(), groups: m });
    }
  }
  return out;
}
export const srcOf = (h: Hit): Source => ({ document_id: h.doc.id, document: h.doc.name, page: h.page.page, section: sectionOf(h.page), excerpt: clip(h.line) });

const num = (s: string) => Number(s.replace(/,/g, ""));

export type Ingest = {
  supplier: { name: string | null; registration_number: string | null; contact_email: string | null; name_variants: { value: string; source: Source }[]; registration_variants: { value: string; source: Source }[] };
  price: { amount: number | null; currency: string | null; currency_assumed: boolean; price_usd: number | null; source: Source | null };
  delivery: { days: number | null; candidates: { days: number; source: Source }[] };
  mandatory_documents: Record<string, { present: boolean; source: Source | null; reason?: string }>;
  technical_specifications: Record<string, { value: number | null; source: Source | null }>;
  extracted_claims: Claim[];
  unsupported_claims: { claim: string; source: Source; needs: string }[];
  injection_flags: Source[];
  document_references: { document_id: string; name: string; kind: string; parse_status: string; pages: number }[];
  parse_issues: string[];
  missing_information: string[];
  metrics: { price_usd: number | null; delivery_days: number | null; doc_completeness: number; technical_compliance: number | null };
  confidence: number;
};

export function extractBid(req: any, docs: DocRow[]): Ingest {
  const missing: string[] = [];
  const parse_issues = docs.map(documentIssue).filter((x): x is string => !!x);
  const claims: Claim[] = [];
  const push = (field: string, value: unknown, h: Hit | undefined, conf = 0.95) => { if (h) claims.push({ field, value, source: srcOf(h), confidence: conf }); };

  // Supplier
  const names = scan(docs, /^Supplier:\s*(.+)$/i);
  const regs = scan(docs, /^Registration Number:\s*(.+)$/i);
  const emails = scan(docs, /^Contact Email:\s*(.+)$/i);
  const comp = (arr: Hit[]) => arr.find((h) => h.doc.kind === "compliance") ?? arr[0];
  const nameH = comp(names), regH = comp(regs), emailH = comp(emails);
  push("supplier_name", nameH?.groups[1], nameH); push("registration_number", regH?.groups[1], regH); push("contact_email", emailH?.groups[1], emailH);
  for (const f of req.mandatory?.supplier_fields ?? []) {
    const have = f === "supplier_name" ? nameH : f === "registration_number" ? regH : f === "contact_email" ? emailH : undefined;
    if (!have) missing.push(`required supplier field not found: ${f}`);
  }

  // Price. NOTE (deliberate, documented limitation): currency is read only when printed next to the amount.
  const priceH = scan(docs, /^Total Price:\s*(?:([A-Z]{3})\s+)?([\d,]+(?:\.\d+)?)\s*(?:([A-Z]{3}))?\s*$/i)[0];
  let amount: number | null = null, currency: string | null = null, assumed = false, priceUsd: number | null = null;
  if (priceH) {
    amount = num(priceH.groups[2]);
    currency = (priceH.groups[1] || priceH.groups[3] || "").toUpperCase() || null;
    const tcur = req.financial?.currency ?? "USD";
    if (!currency) { assumed = true; currency = tcur; missing.push("currency not stated next to the total price; tender currency assumed (low confidence)"); }
    const fx = req.financial?.fx_reference ?? {};
    const cur = currency as string;
    priceUsd = cur === tcur ? amount : fx[cur] ? Math.round((amount / fx[cur]) * 100) / 100 : null;
    push("total_price", { amount, currency }, priceH, assumed ? 0.5 : 0.95);
  } else missing.push("total price not found");

  // Delivery (collect ALL candidates; conflicts are a finding, never silently resolved)
  const dels = scan(docs, /^Delivery Period:\s*(\d+)\s*days?/i);
  const candidates = dels.map((h) => ({ days: Number(h.groups[1]), source: srcOf(h) }));
  const primary = dels.find((h) => h.doc.kind === "financial") ?? dels[0];
  dels.forEach((h) => push("delivery_period_days", Number(h.groups[1]), h));
  if (!dels.length) missing.push("delivery period not found");

  // Technical specs
  const specRes: Record<string, RegExp> = {
    ssd_capacity_gb: /^SSD Capacity:\s*(\d+)\s*GB/i, ram_gb: /^RAM:\s*(\d+)\s*GB/i,
    display_inches: /^Display Size:\s*([\d.]+)\s*inch/i, warranty_months: /^Warranty:\s*(\d+)\s*months?/i,
  };
  const tech: Ingest["technical_specifications"] = {};
  for (const r of req.technical ?? []) {
    const h = specRes[r.key] ? scan(docs, specRes[r.key])[0] : undefined;
    tech[r.key] = { value: h ? Number(h.groups[1]) : null, source: h ? srcOf(h) : null };
    push(r.key, tech[r.key].value, h);
    if (!h) missing.push(`technical value not found: ${r.label}`);
  }

  // Mandatory documents (by section header)
  const headerMap: Record<string, RegExp> = {
    business_registration: /business registration/i, tax_clearance: /tax clearance certificate/i,
    bid_security: /bid security/i, technical_schedule: /^technical schedule/i, price_schedule: /price schedule/i,
  };
  const mand: Ingest["mandatory_documents"] = {};
  for (const d of req.mandatory?.documents ?? []) {
    let found: Source | null = null; let reason: string | undefined;
    for (const doc of docs) {
      if (documentIssue(doc)) continue;
      const pg = doc.pages!.find((p) => headerMap[d.key]?.test(sectionOf(p)));
      if (pg) { found = { document_id: doc.id, document: doc.name, page: pg.page, section: sectionOf(pg), excerpt: clip(pg.text.split("\n").slice(0, 3).join(" | ")) }; break; }
    }
    if (!found) {
      const bad = docs.find((x) => documentIssue(x) && ((d.key === "technical_schedule" && x.kind === "technical") || (d.key === "price_schedule" && x.kind === "financial")));
      reason = bad ? `UNREADABLE: ${documentIssue(bad)}` : "NOT_FOUND";
      missing.push(`mandatory document ${reason === "NOT_FOUND" ? "missing" : "unreadable"}: ${d.label}`);
    }
    mand[d.key] = { present: !!found, source: found, ...(reason ? { reason } : {}) };
  }

  // Claims needing supporting documents (e.g. "holds ISO 9001 certification")
  const unsupported: Ingest["unsupported_claims"] = [];
  for (const h of scan(docs, /ISO\s*(\d{4,5}).*certif/i)) {
    const std = `ISO ${h.groups[1]}`;
    push("claim_certification", std, h, 0.7);
    const supported = docs.some((d) => !documentIssue(d) && d.pages!.some((p) => new RegExp(`certificate\\s*${std}`, "i").test(sectionOf(p))));
    if (!supported) { unsupported.push({ claim: `Supplier claims ${std} certification`, source: srcOf(h), needs: `Certificate ${std}` }); missing.push(`no supporting certificate for claim: ${std}`); }
  }

  const injections = scan(docs, INJECTION_RE).map(srcOf);

  const present = Object.values(mand).filter((m) => m.present).length;
  const total = Object.keys(mand).length || 1;
  const known = (req.technical ?? []).filter((r: any) => tech[r.key]?.value != null);
  const met = known.filter((r: any) => cmp(tech[r.key].value!, r.op, r.value)).length;

  let confidence = 1 - 0.08 * missing.length - 0.25 * parse_issues.length - (assumed ? 0.2 : 0);
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));

  return {
    supplier: {
      name: nameH?.groups[1] ?? null, registration_number: regH?.groups[1] ?? null, contact_email: emailH?.groups[1] ?? null,
      name_variants: names.map((h) => ({ value: h.groups[1], source: srcOf(h) })),
      registration_variants: regs.map((h) => ({ value: h.groups[1], source: srcOf(h) })),
    },
    price: { amount, currency, currency_assumed: assumed, price_usd: priceUsd, source: priceH ? srcOf(priceH) : null },
    delivery: { days: primary ? Number(primary.groups[1]) : null, candidates },
    mandatory_documents: mand, technical_specifications: tech, extracted_claims: claims, unsupported_claims: unsupported,
    injection_flags: injections,
    document_references: docs.map((d) => ({ document_id: d.id, name: d.name, kind: d.kind, parse_status: d.parse_status, pages: d.pages?.length ?? 0 })),
    parse_issues, missing_information: missing,
    metrics: {
      price_usd: priceUsd, delivery_days: primary ? Number(primary.groups[1]) : null,
      doc_completeness: Math.round((present / total) * 1000) / 1000,
      technical_compliance: known.length ? Math.round((met / (req.technical?.length || 1)) * 1000) / 1000 : null,
    },
    confidence,
  };
}

export function cmp(a: number, op: string, b: number) { return op === ">=" ? a >= b : op === "<=" ? a <= b : op === "==" ? a === b : false; }

/** Normalise a supplier name for comparison. */
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\b(ltd|limited|pty|co|inc|llc)\b/g, "").replace(/\s+/g, " ").trim();
