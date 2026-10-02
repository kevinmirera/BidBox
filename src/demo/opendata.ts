/**
 * SYNTHETIC SAMPLE rows for the shared open-contracting schema, so the market resources and search have
 * something to read before real OCDS data is ingested. Everything here is invented: names, ocids, values.
 * Rows are tagged (ocid prefix "ocds-sample-", data source name "Synthetic sample feed") so they are easy to find and delete.
 */
type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;

const AUTH: [string, string, string, string, string][] = [
  // iso, country, currency, update_frequency, authority (generic descriptor, not a claim about the real portal)
  ["KE", "Kenya", "KES", "daily", "Public procurement portal"],
  ["RW", "Rwanda", "RWF", "daily", "e-Procurement system"],
  ["TZ", "Tanzania", "TZS", "daily", "e-Procurement system"],
  ["NG", "Nigeria", "NGN", "current", "Federal procurement portal"],
  ["ZA", "South Africa", "ZAR", "current", "National treasury eTenders"],
  ["LR", "Liberia", "LRD", "current", "Procurement authority portal"],
  ["GH", "Ghana", "GHS", "monthly", "Public procurement authority"],
  ["ZM", "Zambia", "ZMW", "monthly", "Public procurement authority"],
  ["UG", "Uganda", "UGX", "monthly", "Public procurement authority"],
];
const FX: Record<string, number> = { KES: 129, RWF: 1400, TZS: 2600, NGN: 1550, ZAR: 18, LRD: 190, GHS: 15, ZMW: 26, UGX: 3700 };
const ITEMS = [
  ["Supply of laptop computers", 40000, 90000], ["Supply of desktop computers and monitors", 30000, 70000], ["Supply of network equipment", 25000, 120000],
  ["Supply of office furniture", 15000, 60000], ["Supply of medical consumables", 20000, 150000], ["Construction of health centre", 200000, 900000],
  ["Supply of ICT hardware for schools", 50000, 200000], ["Road maintenance services", 150000, 800000],
] as const;

// tiny deterministic PRNG so the sample is stable between runs
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

export async function seedOpenData(query: QueryFn) {
  const has = await query(`SELECT to_regclass('public.countries') c, to_regclass('public.procurements') p, to_regclass('public.awards') a, to_regclass('public.data_sources') d, to_regclass('public.procuring_entities') e, to_regclass('public.suppliers') s`);
  const h = has[0] ?? {};
  if (!(h.c && h.p && h.a && h.d && h.e && h.s)) return { seeded: false, reason: "open contracting tables not present" };
  const existing = await query(`SELECT count(*)::int AS n FROM procurements WHERE ocid LIKE 'ocds-sample-%'`);
  if (existing[0].n > 0) return { seeded: false, reason: "sample open data already loaded", procurements: existing[0].n };
  const anyReal = await query(`SELECT count(*)::int AS n FROM procurements`);
  if (anyReal[0].n > 0) return { seeded: false, reason: "procurements table already contains data; sample data not added" };

  let procurements = 0, awards = 0;
  const rand = rng(42);
  for (const [iso, name, cur, freq, authority] of AUTH) {
    let c = await query(`SELECT id FROM countries WHERE iso_code=$1`, [iso]);
    if (!c[0]) c = await query(`INSERT INTO countries (iso_code,name,currency_code) VALUES ($1,$2,$3) RETURNING id`, [iso, name, cur]);
    const countryId = c[0].id;
    const ds = await query(`INSERT INTO data_sources (country_id,name,organization,format,schema_version,update_frequency,last_successful_sync,is_active) VALUES ($1,$2,$3,'OCDS','1.1',$4,now(),true) RETURNING id`, [countryId, `Synthetic sample feed (${iso})`, authority, freq]);
    const ent = await query(`INSERT INTO procuring_entities (country_id,name,entity_type) VALUES ($1,$2,'public body') RETURNING id`, [countryId, `${name} Sample Ministry of Health`]);
    const sup: string[] = [];
    for (const s of ["Alpha Supplies Ltd", "Baobab Technologies", "Cedar Works Co"]) sup.push((await query(`INSERT INTO suppliers (country_id,name) VALUES ($1,$2) RETURNING id`, [countryId, `${s} (${iso} sample)`]))[0].id);
    for (let i = 0; i < ITEMS.length; i++) {
      const [title, lo, hi] = ITEMS[i];
      const usd = lo + rand() * (hi - lo);
      const est = Math.round(usd * FX[cur]);
      const date = new Date(Date.UTC(2026, 0, 5 + i * 17 + Math.floor(rand() * 5))).toISOString();
      const ocid = `ocds-sample-${iso.toLowerCase()}-${String(i + 1).padStart(3, "0")}`;
      const p = await query(`INSERT INTO procurements (ocid,country_id,source_id,title,description,procurement_method,status,published_date,currency,estimated_value,procuring_entity_id)
        VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10) RETURNING id`, [ocid, countryId, ds[0].id, title, `${title} (synthetic sample record)`, i % 4 === 3 ? "active" : "complete", date, cur, est, ent[0].id]);
      procurements++;
      if (i % 4 !== 3) {
        const val = Math.round(est * (0.88 + rand() * 0.2));
        await query(`INSERT INTO awards (procurement_id,award_id,title,status,date,value,currency,supplier_id) VALUES ($1,$2,$3,'active',$4,$5,$6,$7)`, [p[0].id, `${ocid}-award`, title, date, val, cur, sup[i % 3]]);
        awards++;
      }
    }
  }
  return { seeded: true, synthetic: true, countries: AUTH.length, procurements, awards };
}
