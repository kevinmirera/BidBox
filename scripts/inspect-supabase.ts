/**
 * Prints the tables, columns and row counts exposed by a Supabase project's REST API, so the
 * procurement-data resources can be built against the REAL schema instead of a guessed one.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_KEY=<key> npx tsx scripts/inspect-supabase.ts
 *
 * Use the SECRET key if the publishable key returns 401/403 on the schema listing (Supabase may restrict the
 * OpenAPI schema to the secret key). Run it locally; the key stays in your shell and is never written to a file.
 * Output contains table/column names and counts only, no row data.
 */
const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
if (!url || !key) { console.error("Set SUPABASE_URL and SUPABASE_KEY"); process.exit(1); }
const h = { apikey: key, authorization: `Bearer ${key}`, accept: "application/openapi+json" };

(async () => {
  const r = await fetch(`${url}/rest/v1/`, { headers: h });
  if (!r.ok) { console.error(`schema listing failed: HTTP ${r.status}. Try SUPABASE_KEY=<secret key>.`); process.exit(1); }
  const spec: any = await r.json();
  const defs = spec.definitions ?? spec.components?.schemas ?? {};
  for (const [name, def] of Object.entries<any>(defs)) {
    const cols = Object.entries<any>(def.properties ?? {}).map(([c, p]) => `${c}:${p.format ?? p.type}`);
    let count = "?";
    try {
      const c = await fetch(`${url}/rest/v1/${encodeURIComponent(name)}?select=*&limit=0`, { headers: { apikey: key, authorization: `Bearer ${key}`, prefer: "count=exact" } });
      count = c.headers.get("content-range")?.split("/")[1] ?? `HTTP ${c.status}`;
    } catch {}
    console.log(`\n${name}  (rows: ${count})\n  ${cols.join(", ")}`);
  }
})();
