import { q } from "../lib/db";
import { calibrationSize, deviation, dist, exceeds } from "./calibration";

/**
 * Read-only access to the shared-schema open contracting data (OCDS-style tables: countries, data_sources,
 * procurements, awards, ...). ADVISORY CONTEXT ONLY: never feeds the calibration reference, which is built
 * from the bids of the tender being evaluated. Every result carries provenance (ocid, source URL) and freshness.
 */
const NOTE = "Advisory market context from published open contracting data. Not used in calibration, scoring or any decision. Coverage differs by authority; check freshness.";
const like = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
export const ISO = /^[A-Za-z]{2,3}$/;

async function available() {
  const r = await q(`SELECT to_regclass('public.countries') AS c, to_regclass('public.procurements') AS p, to_regclass('public.awards') AS a, to_regclass('public.data_sources') AS d`);
  return !!(r[0]?.c && r[0]?.p && r[0]?.a && r[0]?.d);
}

export async function marketCountries() {
  if (!(await available())) return { available: false, note: "Open contracting tables are not present in this database.", countries: [] };
  const rows = await q(`
    SELECT c.iso_code, c.name, c.currency_code,
      (SELECT COALESCE(json_agg(json_build_object('name', ds.name, 'organization', ds.organization, 'update_frequency', ds.update_frequency,
         'last_successful_sync', ds.last_successful_sync, 'active', ds.is_active)), '[]'::json) FROM data_sources ds WHERE ds.country_id = c.id) AS sources,
      (SELECT count(*) FROM procurements p WHERE p.country_id = c.id) AS procurements
    FROM countries c ORDER BY c.name`);
  const countries = rows.map((r: any) => ({ ...r, procurements: Number(r.procurements), freshness: (r.sources ?? []).map((s: any) => ({ source: s.name, update_frequency: s.update_frequency, last_successful_sync: s.last_successful_sync ?? "never synced" })) }));
  return { available: true, note: NOTE, countries, total_procurements: countries.reduce((a: number, c: any) => a + c.procurements, 0) };
}

async function freshness(iso: string) {
  return q(`SELECT ds.name AS source, ds.update_frequency, ds.last_successful_sync FROM data_sources ds JOIN countries c ON c.id = ds.country_id WHERE c.iso_code = upper($1)`, [iso]);
}

export async function marketProcurements(iso: string, keyword: string) {
  if (!ISO.test(iso)) throw new Error("invalid country code");
  if (!(await available())) return { available: false, note: "Open contracting tables are not present in this database.", results: [] };
  const kw = keyword.trim().slice(0, 60);
  const rows = await q(`
    SELECT p.ocid, c.iso_code, p.title, p.status, p.procurement_method, p.published_date, p.currency, p.estimated_value, p.source_url, pe.name AS procuring_entity
    FROM procurements p JOIN countries c ON c.id = p.country_id LEFT JOIN procuring_entities pe ON pe.id = p.procuring_entity_id
    WHERE c.iso_code = upper($1) AND (p.title ILIKE $2 OR p.description ILIKE $2)
    ORDER BY p.published_date DESC NULLS LAST LIMIT 25`, [iso, like(kw)]);
  return { available: true, note: NOTE, country: iso.toUpperCase(), keyword: kw, count: rows.length, freshness: await freshness(iso), results: rows,
    ...(rows.length === 0 ? { message: "No matching records (data may not be synced for this authority yet)." } : {}) };
}

export async function marketBenchmark(iso: string, keyword: string) {
  if (!ISO.test(iso)) throw new Error("invalid country code");
  if (!(await available())) return { available: false, note: "Open contracting tables are not present in this database.", benchmarks: [] };
  const kw = keyword.trim().slice(0, 60);
  const stats = await q(`
    SELECT a.currency, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY a.value) AS median, min(a.value) AS min, max(a.value) AS max
    FROM awards a JOIN procurements p ON p.id = a.procurement_id JOIN countries c ON c.id = p.country_id
    WHERE c.iso_code = upper($1) AND (p.title ILIKE $2 OR p.description ILIKE $2) AND a.value > 0
    GROUP BY a.currency ORDER BY n DESC`, [iso, like(kw)]);
  const refs = await q(`
    SELECT p.ocid, p.title, a.value, a.currency, a.date FROM awards a JOIN procurements p ON p.id = a.procurement_id JOIN countries c ON c.id = p.country_id
    WHERE c.iso_code = upper($1) AND (p.title ILIKE $2 OR p.description ILIKE $2) AND a.value > 0 ORDER BY a.date DESC NULLS LAST LIMIT 10`, [iso, like(kw)]);
  return { available: true, note: NOTE, country: iso.toUpperCase(), keyword: kw, benchmarks: stats.map((s: any) => ({ ...s, median: s.median == null ? null : Number(s.median), min: Number(s.min), max: Number(s.max),
    caution: s.n < 5 ? "Fewer than 5 awards: not a meaningful benchmark." : undefined })), sample_awards: refs, freshness: await freshness(iso),
    ...(stats.length === 0 ? { message: "No awards found for this keyword." } : {}) };
}

/**
 * Search with the same investigation-allocation idea as bid evaluation: results are taken in publication order,
 * the first ~1/e (36.8%) form a per-currency reference of estimated value, and later results are marked
 * "stands out" when they deviate a lot from that reference. "Stands out" means "worth a closer look", never "best".
 */
export async function searchProcurements(a: { keyword: string; country?: string; limit?: number }) {
  if (a.country && !ISO.test(a.country)) throw new Error("invalid country code");
  if (!(await available())) return { available: false, note: "Open contracting tables are not present in this database.", results: [] };
  const kw = a.keyword.trim().slice(0, 60); const limit = Math.min(Math.max(a.limit ?? 30, 3), 100);
  const rows = await q(`
    SELECT p.ocid, c.iso_code AS country, p.title, p.status, p.procurement_method, p.published_date, p.currency, p.estimated_value, p.source_url, pe.name AS procuring_entity
    FROM procurements p JOIN countries c ON c.id = p.country_id LEFT JOIN procuring_entities pe ON pe.id = p.procuring_entity_id
    WHERE (p.title ILIKE $1 OR p.description ILIKE $1) AND ($2::text IS NULL OR c.iso_code = upper($2))
    ORDER BY p.published_date ASC NULLS FIRST, p.ocid LIMIT ${limit}`, [like(kw), a.country ?? null]);
  const n = rows.length, k = calibrationSize(n);
  const calSet = rows.slice(0, k);
  const byCur: Record<string, ReturnType<typeof dist>> = {};
  for (const cur of new Set(calSet.map((r: any) => r.currency).filter(Boolean))) {
    const vals = calSet.filter((r: any) => r.currency === cur && r.estimated_value != null).map((r: any) => Number(r.estimated_value));
    if (vals.length >= 2) byCur[cur as string] = dist(vals);
  }
  const results = rows.map((r: any, i: number) => {
    const role = i < k ? "CALIBRATION" : "SEQUENTIAL";
    const d = r.estimated_value != null && byCur[r.currency] ? deviation(Number(r.estimated_value), byCur[r.currency]) : null;
    return { ...r, estimated_value: r.estimated_value == null ? null : Number(r.estimated_value), role, deviation_pct: d?.deviation_pct ?? null, stands_out: role === "SEQUENTIAL" && exceeds(d) };
  });
  return { available: true, note: NOTE + " Results are taken in publication order; the first ~37% (1/e) calibrate a per-currency value reference; later results that deviate strongly are marked 'stands out' (worth a look, not 'best').",
    keyword: kw, country: a.country?.toUpperCase() ?? "ALL", count: n,
    calibration: { fraction: Number((1 / Math.E).toFixed(4)), size: k, total: n, reference: byCur, note: n < 3 ? "Too few results to calibrate." : undefined },
    results, standouts: results.filter((r) => r.stands_out).length,
    ...(n === 0 ? { message: "No matching records (data may not be synced yet)." } : {}) };
}
