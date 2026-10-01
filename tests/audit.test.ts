import test from "node:test";
import assert from "node:assert/strict";
import { getDb, q } from "../src/lib/db";
import { appendAudit, verifyChain, withAudit } from "../src/mcp/audit";

test("audit rows cannot be updated or deleted (DB trigger)", async () => {
  await getDb();
  const a = await appendAudit({ run_id: "t-run", tender_id: "T", bid_id: null, tool_name: "x", input: { a: 1 }, output: { b: [1, 2] }, status: "SUCCESS", actor: "test", started_at: new Date(), duration_ms: 1 });
  await assert.rejects(q(`UPDATE tool_calls SET status='SUCCESS', output='{}'::jsonb WHERE id=$1`, [a.audit_id]), /append-only/);
  await assert.rejects(q(`DELETE FROM tool_calls WHERE id=$1`, [a.audit_id]), /append-only/);
  assert.deepEqual(await verifyChain("t-run"), { intact: true, records: 1 });
});
test("middleware audits successes AND failures, including Date-bearing outputs", async () => {
  await getDb();
  const ok = withAudit("demo_ok", async () => ({ data: { when: new Date(), nested: { z: 1, a: 2 } } }));
  const boom = withAudit("demo_boom", async () => { throw new Error("kaboom"); });
  const r1 = await ok({ tender_id: "T" }, { runId: "t-run2", actor: "test" });
  const r2 = await boom({ tender_id: "T" }, { runId: "t-run2", actor: "test" });
  assert.equal(r1.status, "SUCCESS"); assert.equal(r2.status, "ERROR"); assert.ok(r2.audit.audit_id);
  const rows = await q(`SELECT tool_name, status, error FROM tool_calls WHERE run_id='t-run2' ORDER BY id`);
  assert.deepEqual(rows.map((r: any) => r.status), ["SUCCESS", "ERROR"]); assert.equal(rows[1].error, "kaboom");
  assert.equal((await verifyChain("t-run2")).intact, true);
});
test("evaluations table structurally cannot record an award", async () => {
  await getDb(); const t = (await q(`SELECT id FROM tenders LIMIT 1`))[0];
  await assert.rejects(q(`INSERT INTO evaluations (tender_id, package, award_decisions_made) VALUES ($1,'{}'::jsonb,1)`, [t.id]));
});
