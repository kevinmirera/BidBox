import crypto from "node:crypto";
import { BID_COUNT, TENDER, TENDER_DOCS, buildBid } from "./data";

type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;

/** Idempotent: does nothing if the demo tender already exists. */
export async function seedDemo(query: QueryFn) {
  const existing = await query("SELECT id FROM tenders WHERE ref = $1", [TENDER.ref]);
  if (existing.length) return { seeded: false, tender_ref: TENDER.ref };

  const t = await query(
    `INSERT INTO tenders (ref, title, metadata, requirements, criteria)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) RETURNING id`,
    [TENDER.ref, TENDER.title, JSON.stringify(TENDER.metadata), JSON.stringify(TENDER.requirements), JSON.stringify(TENDER.criteria)],
  );
  const tenderId = t[0].id;
  const insertDoc = async (bidId: string | null, d: any) => {
    const text = JSON.stringify(d.pages ?? []);
    await query(
      `INSERT INTO documents (tender_id, bid_id, name, kind, parse_status, parse_error, pages, size_bytes, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [tenderId, bidId, d.name, d.kind, d.parse_status, d.parse_error ?? null, d.pages ? JSON.stringify(d.pages) : null,
        Buffer.byteLength(text), crypto.createHash("sha256").update(text).digest("hex")],
    );
  };
  for (const d of TENDER_DOCS) await insertDoc(null, d);
  for (let i = 0; i < BID_COUNT; i++) {
    const b = buildBid(i);
    const r = await query(`INSERT INTO bids (tender_id, ref, seq, supplier_hint) VALUES ($1,$2,$3,$4) RETURNING id`, [tenderId, b.ref, i + 1, b.supplier_hint]);
    for (const d of b.docs) await insertDoc(r[0].id, d);
  }
  return { seeded: true, tender_ref: TENDER.ref, bids: BID_COUNT };
}
