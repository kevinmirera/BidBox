/**
 * Protocol-level MCP test (not just HTTP 200): connect -> initialize -> list tools -> call tools ->
 * structured result -> error handling -> resources. Usage: npm run test:mcp  (server must be running)
 *   MCP_URL=https://<project>.vercel.app/api/mcp MCP_AUTH_TOKEN=... npm run test:mcp
 */
import { McpConnection } from "../src/agent/mcp-client";

const url = process.env.MCP_URL || process.env.MCP_SERVER_URL || "http://localhost:3000/api/mcp";
const token = process.env.MCP_AUTH_TOKEN;
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };

async function main() {
  console.log(`MCP endpoint: ${url}`);
  const runId = `mcp-test-${Date.now()}`;
  const mcp = new McpConnection("test", url, { token, headers: { "x-bidbox-run-id": runId, "x-bidbox-actor": "mcp-test" } });
  await mcp.connect();
  check("connect + initialize handshake", true);

  const tools = await mcp.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["load_tender", "ingest_bid", "compare_bid", "verify_evidence", "generate_committee_file", "log_action"]) check(`tool discovered: ${n}`, names.includes(n));
  check("no award/select/approve tool exists", !names.some((n) => /award|winner|select|approve/i.test(n)), `(${names.join(", ")})`);
  check("tools publish JSON Schema inputs", tools.every((t) => t.inputSchema?.type === "object"));

  const lt = await mcp.callTool("load_tender", { tender_id: "TND-2026-014" });
  check("call load_tender -> structured result", !lt.isError && lt.data?.tender?.ref === "TND-2026-014" && Array.isArray(lt.data?.technical_requirements));
  check("result carries audit record id", typeof lt.data?._audit?.audit_id === "number");

  const bad = await mcp.callTool("load_tender", { tender_id: "../../etc/passwd" }).catch((e) => ({ isError: true, data: String(e) }));
  check("invalid arguments rejected", bad.isError === true);
  const nf = await mcp.callTool("load_tender", { tender_id: "TND-DOES-NOT-EXIST" });
  check("unknown tender -> structured error (isError)", nf.isError === true && !!nf.data?.error?.message);

  // Small end-to-end tool chain on one bid (calibration bids first so a reference exists)
  for (let i = 1; i <= 8; i++) await mcp.callTool("ingest_bid", { tender_id: "TND-2026-014", bid_id: `BID-${String(i).padStart(3, "0")}` });
  const cmp = await mcp.callTool("compare_bid", { tender_id: "TND-2026-014", bid_id: "BID-008" });
  const flagged = cmp.data?.anomalies?.find((a: any) => a.kind === "PRICE_DEVIATION");
  check("compare_bid flags BID-008 price deviation", !!flagged, flagged ? flagged.description : "");
  check("compare_bid output has no winner/recommendation fields", !/"winner"|best_bid|recommended_supplier/.test(JSON.stringify(cmp.data)));
  const vf = await mcp.callTool("verify_evidence", { tender_id: "TND-2026-014", bid_id: "BID-008", finding_id: flagged.finding_id });
  check("verify_evidence returns source document/page/section", vf.data?.verified === true && !!vf.data?.source?.document && Number.isInteger(vf.data?.source?.page) && !!vf.data?.source?.section, JSON.stringify(vf.data?.source));
  const lg = await mcp.callTool("log_action", { agent_run_id: runId, tender_id: "TND-2026-014", tool_name: "note", inputs: { msg: "hello" } });
  check("log_action returns audit id + timestamp", typeof lg.data?.audit_record_id === "number" && !!lg.data?.timestamp);

  const tpl = await mcp.listResources();
  check("resource templates exposed", (tpl as any).resourceTemplates?.length >= 5, `${(tpl as any).resourceTemplates?.length}`);
  const rs = await mcp.readResource("bidbox://tenders/TND-2026-014/evaluation-state");
  const state = JSON.parse((rs as any).contents[0].text);
  check("read resource: evaluation-state (award_decisions_made = 0)", state.award_decisions_made === 0);
  await mcp.close();

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll MCP protocol checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("MCP test crashed:", e); process.exit(1); });
