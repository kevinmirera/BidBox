import test from "node:test";
import assert from "node:assert/strict";
import { getDb, q } from "../src/lib/db";
import { marketBenchmark, marketCountries, marketProcurements, searchProcurements } from "../src/domain/market";

test("market resources degrade gracefully when the open-data tables are absent", async () => {
  await getDb();
  const r = await marketCountries();
  assert.equal(r.available, false);
});
test("market resources return provenance, freshness and benchmarks from the shared schema", async () => {
  await getDb();
  await q(`CREATE TABLE countries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), iso_code text, name text, currency_code text)`);
  await q(`CREATE TABLE data_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), country_id uuid, name text, organization text, update_frequency text, last_successful_sync timestamptz, is_active boolean)`);
  await q(`CREATE TABLE procuring_entities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
  await q(`CREATE TABLE procurements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ocid text, country_id uuid, title text, description text, status text, procurement_method text, published_date timestamptz, currency text, estimated_value numeric, source_url text, procuring_entity_id uuid)`);
  await q(`CREATE TABLE awards (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), procurement_id uuid, value numeric, currency text, date timestamptz)`);
  const c = (await q(`INSERT INTO countries (iso_code,name,currency_code) VALUES ('KE','Kenya','KES') RETURNING id`))[0].id;
  await q(`INSERT INTO data_sources (country_id,name,organization,update_frequency,last_successful_sync,is_active) VALUES ($1,'KE feed','PPRA','daily',now(),true)`, [c]);
  for (const v of [100, 120, 140, 160, 200]) {
    const p = (await q(`INSERT INTO procurements (ocid,country_id,title,published_date) VALUES ($1,$2,'Supply of laptops',now()) RETURNING id`, [`ocds-x-${v}`, c]))[0].id;
    await q(`INSERT INTO awards (procurement_id,value,currency,date) VALUES ($1,$2,'KES',now())`, [p, v]);
  }
  const cs: any = await marketCountries();
  assert.equal(cs.available, true); assert.equal(cs.countries[0].procurements, 5); assert.equal(cs.countries[0].freshness[0].update_frequency, "daily");
  const b: any = await marketBenchmark("ke", "laptop");
  assert.equal(b.benchmarks[0].n, 5); assert.equal(b.benchmarks[0].median, 140); assert.ok(b.sample_awards[0].ocid.startsWith("ocds-x"));
  const none: any = await marketProcurements("KE", "tractor"); assert.equal(none.count, 0); assert.ok(none.message);
  await assert.rejects(marketProcurements("K;DROP", "x"), /invalid country/);

  // calibrated search: 10 more KES laptop records, one extreme outlier published last
  for (let i = 0; i < 9; i++) {
    const p = (await q(`INSERT INTO procurements (ocid,country_id,title,published_date,currency,estimated_value) VALUES ($1,$2,'Supply of widgets (batch)',now() + ($3 || ' days')::interval,'KES',$4) RETURNING id`, [`ocds-s-${i}`, c, String(i + 1), 100 + i * 5]))[0].id; void p;
  }
  await q(`INSERT INTO procurements (ocid,country_id,title,published_date,currency,estimated_value) VALUES ('ocds-s-outlier',$1,'Supply of widgets (huge)',now() + interval '30 days','KES',900)`, [c]);
  const sr: any = await searchProcurements({ keyword: "widget", country: "KE", limit: 30 });
  assert.equal(sr.count, 10);
  assert.equal(sr.calibration.size, 4); // round(10/e)
  assert.equal(sr.results.filter((r: any) => r.role === "CALIBRATION").length, 4);
  const out = sr.results.find((r: any) => r.ocid === "ocds-s-outlier");
  assert.equal(out.role, "SEQUENTIAL"); assert.equal(out.stands_out, true);
  assert.ok(sr.results.filter((r: any) => r.role === "CALIBRATION").every((r: any) => r.stands_out === false));
  assert.ok(!/"winner"|best_bid|recommended/.test(JSON.stringify(sr)));
});
