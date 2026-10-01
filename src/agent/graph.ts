import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { agentLoop, type ConnFor, type ToolEvent } from "./loop";
import type { McpConnection } from "./mcp-client";
import { INVESTIGATE_PROMPT, PLAN_PROMPT, PROCESS_PROMPT, SYSTEM } from "./prompts";
import type { ModelProvider, ToolDef } from "./provider";

const concat = <T,>(a: T[], b: T[]) => a.concat(b);
const keep = <T,>(d: () => T) => Annotation<T>({ reducer: (_a, b) => b, default: d });

/** Explicit workflow state (spec section 8). */
export const State = Annotation.Root({
  tender_id: keep<string>(() => ""),
  run_id: keep<string>(() => ""),
  bid_ids: keep<string[]>(() => []),
  current_index: keep<number>(() => 0),
  current_bid: keep<string | null>(() => null),
  calibration_size: keep<number>(() => 0),
  calibration_complete: keep<boolean>(() => false),
  reference_distribution: keep<any>(() => ({})),
  calibration_stability: keep<number>(() => 0),
  findings: keep<any[]>(() => []),
  evidence: keep<any[]>(() => []),
  investigation_queue: keep<any[]>(() => []),
  tool_calls: Annotation<ToolEvent[]>({ reducer: concat, default: () => [] }),
  errors: Annotation<string[]>({ reducer: concat, default: () => [] }),
  recovery_attempts: keep<number>(() => 0),
  human_flags: Annotation<string[]>({ reducer: concat, default: () => [] }),
  plan: keep<string>(() => ""),
  committee_file: keep<any>(() => null),
  human_review_required: keep<boolean>(() => false),
  phase: keep<string>(() => "START"),          // observe | calibrate | investigate | verify | continue
  processed_this_invocation: keep<number>(() => 0),
  status: keep<string>(() => "RUNNING"),       // RUNNING | PAUSED | AGENT ANALYSIS COMPLETE
  node_trace: Annotation<string[]>({ reducer: concat, default: () => [] }),
});
export type S = typeof State.State;

export type GraphDeps = {
  provider: ModelProvider; connFor: ConnFor; bidBox: McpConnection; tools: ToolDef[];
  onEvent: (e: ToolEvent) => void; onNode?: (n: string, s: Partial<S>) => Promise<void> | void;
  batchSize: number; maxRecovery: number;
  external?: { conn: McpConnection; tools: ToolDef[] } | null;
};

export function buildGraph(d: GraphDeps) {
  const evalState = async (tender: string) => {
    const r: any = await d.bidBox.readResource(`bidbox://tenders/${tender}/evaluation-state`);
    return JSON.parse(r.contents[0].text);
  };
  const tr = (n: string) => ({ node_trace: [n] });
  const call = async (name: string, args: any) => {
    const r = await d.bidBox.callTool(name, args);
    d.onEvent({ at: new Date().toISOString(), node: "deterministic", bid: args.bid_id ?? null, reasoning: "", tool: name, args, status: r.isError ? "ERROR" : "SUCCESS", summary: JSON.stringify(r.data).slice(0, 200), audit_id: r.data?._audit?.audit_id });
    return r;
  };

  const g = new StateGraph(State)
    .addNode("load_tender", async (s: S) => {
      const r = await call("load_tender", { tender_id: s.tender_id });
      if (r.isError) return { ...tr("load_tender"), errors: [`load_tender: ${r.data?.error?.message}`], phase: "FAILED", status: "FAILED" };
      return { ...tr("load_tender"), bid_ids: r.data.bids.map((b: any) => b.bid_id), calibration_size: r.data.calibration_plan.calibration_size };
    })
    .addNode("make_plan", async (s: S) => {
      // Model writes the evaluation plan (no tools). Model failure is non-fatal: plan is advisory.
      try {
        const t: any = (await d.bidBox.callTool("load_tender", { tender_id: s.tender_id })).data;
        const out = await d.provider.step({ system: SYSTEM, messages: [{ role: "user", text: PLAN_PROMPT(t) }], tools: [] });
        return { ...tr("make_plan"), plan: out.text, phase: "observe" };
      } catch (e: any) { return { ...tr("make_plan"), errors: [`plan: ${e.message}`], plan: "(model unavailable; deterministic mechanism continues)", phase: "observe" }; }
    })
    .addNode("calibrate", async (s: S) => {
      const st = await evalState(s.tender_id);
      return { ...tr("calibrate"), calibration_size: st.calibration.size, calibration_complete: st.calibration.phase === "CALIBRATED", calibration_stability: st.calibration.stability, reference_distribution: st.calibration.reference, findings: st.findings, phase: st.calibration.phase === "CALIBRATED" ? "calibrate:done" : "calibrate", current_bid: s.bid_ids[s.current_index] ?? null };
    })
    .addNode("process_bid", async (s: S) => {
      const bid = s.bid_ids[s.current_index];
      const cal = { phase: s.calibration_complete ? "CALIBRATED" : "CALIBRATING", size: s.calibration_size, ingested: s.current_index, stability: s.calibration_stability };
      try {
        const r = await agentLoop({ provider: d.provider, connFor: d.connFor, node: "process_bid", bid, system: SYSTEM, user: PROCESS_PROMPT(bid, s.current_index + 1, s.bid_ids.length, cal, s.tender_id), allowed: ["ingest_bid", "compare_bid", "read_resource"], maxSteps: 6, mcpTools: d.tools, onEvent: d.onEvent });
        return { ...tr("process_bid"), errors: r.errors, current_bid: bid, phase: "comparison" };
      } catch (e: any) { return { ...tr("process_bid"), errors: [`process_bid ${bid}: ${e.message}`], current_bid: bid }; }
    })
    .addNode("decide_investigation", async (s: S) => {
      const st = await evalState(s.tender_id);
      const bidState = st.bids.find((b: any) => b.ref === s.current_bid);
      const queue = st.findings.filter((f: any) => f.bid === s.current_bid && f.status === "OPEN").slice(0, 6);
      const processed = bidState && !["RECEIVED", "INGESTED"].includes(bidState.status);
      return { ...tr("decide_investigation"), findings: st.findings, investigation_queue: queue, calibration_stability: st.calibration.stability, calibration_complete: st.calibration.phase === "CALIBRATED", reference_distribution: st.calibration.reference, phase: queue.length ? "investigate" : processed ? "continue" : "recover" };
    })
    .addNode("investigate", async (s: S) => {
      const hint = s.recovery_attempts > 0 ? "Previous attempt left findings unverified; verify them now, or state why evidence is insufficient." : undefined;
      try {
        const r = await agentLoop({ provider: d.provider, connFor: d.connFor, node: "investigate", bid: s.current_bid, system: SYSTEM, user: INVESTIGATE_PROMPT(s.current_bid!, s.tender_id, s.investigation_queue, hint), allowed: ["verify_evidence", "read_resource", "compare_bid", "log_action", "external"], maxSteps: 10, mcpTools: d.tools, onEvent: d.onEvent, external: d.external ? { ...d.external, runId: s.run_id, tenderId: s.tender_id } : null });
        return { ...tr("investigate"), errors: r.errors, phase: "verify" };
      } catch (e: any) { return { ...tr("investigate"), errors: [`investigate ${s.current_bid}: ${e.message}`] }; }
    })
    .addNode("verify_check", async (s: S) => {
      const st = await evalState(s.tender_id);
      const open = st.findings.filter((f: any) => f.bid === s.current_bid && f.status === "OPEN");
      return { ...tr("verify_check"), findings: st.findings, investigation_queue: open };
    })
    .addNode("recover", async (s: S) => {
      const attempts = s.recovery_attempts + 1;
      const flag = attempts > d.maxRecovery ? [`${s.current_bid}: could not be fully processed/verified after ${d.maxRecovery} recovery attempt(s) - requires human review.`] : [];
      return { ...tr("recover"), recovery_attempts: attempts, human_flags: flag, phase: "recover" };
    })
    .addNode("next_bid", async (s: S) => ({ ...tr("next_bid"), current_index: s.current_index + 1, recovery_attempts: 0, investigation_queue: [], processed_this_invocation: s.processed_this_invocation + 1, phase: "continue" }))
    .addNode("generate_committee_file", async (s: S) => {
      const r = await call("generate_committee_file", { tender_id: s.tender_id, evaluation_run_id: s.run_id });
      if (r.isError) return { ...tr("generate_committee_file"), errors: [`generate_committee_file: ${r.data?.error?.message}`], human_flags: ["Committee file could not be generated - requires human attention."] };
      return { ...tr("generate_committee_file"), committee_file: { evaluation_id: r.data.evaluation_id, summary: r.data.summary, export_status: r.data.export_status, statement: r.data.statement } };
    })
    .addNode("human_review", async (s: S) => ({ ...tr("human_review"), human_review_required: true, status: s.human_flags.length ? "AGENT ANALYSIS INCOMPLETE" : "AGENT ANALYSIS COMPLETE", phase: "COMMITTEE REVIEW REQUIRED" }))
    .addNode("pause", async (s: S) => ({ ...tr("pause"), status: "PAUSED" }));

  // Branching is driven by tool results (via evaluation state), not a fixed chain.
  g.addEdge(START, "load_tender" as any);
  g.addConditionalEdges("load_tender" as any, (s: S) => (s.status === "FAILED" ? END : s.current_index > 0 ? "calibrate" : "make_plan"), { [END]: END, calibrate: "calibrate", make_plan: "make_plan" } as any);
  g.addEdge("make_plan" as any, "calibrate" as any);
  g.addConditionalEdges("calibrate" as any, (s: S) => (s.current_index >= s.bid_ids.length ? "generate_committee_file" : "process_bid"), { generate_committee_file: "generate_committee_file", process_bid: "process_bid" } as any);
  g.addEdge("process_bid" as any, "decide_investigation" as any);
  g.addConditionalEdges("decide_investigation" as any, (s: S) => (s.phase === "investigate" ? "investigate" : s.phase === "continue" ? "next_bid" : "recover"), { investigate: "investigate", next_bid: "next_bid", recover: "recover" } as any);
  g.addEdge("investigate" as any, "verify_check" as any);
  g.addConditionalEdges("verify_check" as any, (s: S) => (s.investigation_queue.length ? "recover" : "next_bid"), { recover: "recover", next_bid: "next_bid" } as any);
  g.addConditionalEdges("recover" as any, (s: S) => {
    if (s.recovery_attempts > d.maxRecovery) return "next_bid";                 // give up -> flagged for humans
    return s.investigation_queue.length ? "investigate" : "process_bid";         // retry the failing stage
  }, { next_bid: "next_bid", investigate: "investigate", process_bid: "process_bid" } as any);
  g.addConditionalEdges("next_bid" as any, (s: S) => (s.current_index >= s.bid_ids.length ? "generate_committee_file" : s.processed_this_invocation >= d.batchSize ? "pause" : "calibrate"), { generate_committee_file: "generate_committee_file", pause: "pause", calibrate: "calibrate" } as any);
  g.addEdge("generate_committee_file" as any, "human_review" as any);
  g.addEdge("human_review" as any, END);
  g.addEdge("pause" as any, END);
  return g.compile();
}
