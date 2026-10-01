import type { ModelProvider, StepInput, StepOutput } from "./provider";
import { ProviderError } from "./provider";

/**
 * ScriptedProvider - a TEST DOUBLE that implements ModelProvider with a small reactive policy
 * (it reads tool results and decides the next call; it is not an LLM and has no reasoning ability).
 * It exists so the graph, MCP loop, audit trail and evidence checks can be exercised offline and in
 * CI. Results obtained with it say NOTHING about Claude's or any open-weights model's quality.
 * Disabled in production by the run route.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted"; readonly model = "scripted-policy-v1"; readonly actor = "scripted:policy-v1";
  private n = 0;
  constructor(private opts: { failAfterSteps?: number; failKind?: "rate_limit" | "other" } = {}) {}
  async step(i: StepInput): Promise<StepOutput> {
    if (this.opts.failAfterSteps != null && ++this.n > this.opts.failAfterSteps) throw new ProviderError("simulated model failure", this.opts.failKind ?? "other");
    const first = (i.messages[0] as any).text as string;
    const tender = first.match(/Tender (TND-[A-Za-z0-9-]+)/)?.[1] ?? "";
    if (!i.tools.length) return { text: "- Check mandatory documents and technical requirements per bid\n- Use first ~37% of bids to calibrate price/delivery references\n- Verify every flagged finding against source pages\n- Leave all award decisions to the human committee", toolCalls: [] };
    const calls = i.messages.flatMap((m: any) => (m.role === "assistant" ? m.toolCalls ?? [] : []));
    const results = i.messages.flatMap((m: any) => (m.role === "tool" ? m.results : []));
    const id = (n: number) => `s${n}-${calls.length}`;
    const done = (t: string): StepOutput => ({ text: t, toolCalls: [] });
    const bid = first.match(/(?:Process|Investigate) (BID-\d+)/)?.[1] ?? "";
    if (/Process BID-/.test(first)) {
      if (!calls.some((c: any) => c.name === "ingest_bid")) return { text: "Ingesting.", toolCalls: [{ id: id(1), name: "ingest_bid", args: { tender_id: tender, bid_id: bid } }] };
      if (!calls.some((c: any) => c.name === "compare_bid")) return { text: "Comparing against the reference.", toolCalls: [{ id: id(2), name: "compare_bid", args: { tender_id: tender, bid_id: bid } }] };
      return done(`${bid} ingested and compared; see findings.`);
    }
    const ids = [...first.matchAll(/finding_id=([0-9a-f-]{36})/g)].map((m) => m[1]);
    const verified = new Set(calls.filter((c: any) => c.name === "verify_evidence").map((c: any) => c.args.finding_id));
    const next = ids.find((x) => !verified.has(x));
    if (next) return { text: "Verifying finding.", toolCalls: [{ id: id(3), name: "verify_evidence", args: { tender_id: tender, bid_id: bid, finding_id: next } }] };
    // tool results influence the next action: contradictions trigger a source-page read
    const contra = results.map((r: any) => { try { return JSON.parse(r.content); } catch { return null; } }).find((o: any) => o?.status === "CONTRADICTED" && o?.source?.document);
    if (contra && !calls.some((c: any) => c.name === "read_resource")) {
      const doc = contra.source.document; const num = doc.match(/Bid_(\d+)/)?.[1];
      return { text: "Contradiction found; reading the source page.", toolCalls: [{ id: id(4), name: "read_resource", args: { uri: `bidbox://tenders/${tender}/bids/BID-${num}/documents/${doc}/pages/${contra.source.page}` } }] };
    }
    return done("Findings verified; remaining items need the human committee.");
  }
}
