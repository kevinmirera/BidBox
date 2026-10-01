import test from "node:test";
import assert from "node:assert/strict";
import { toAnthropicMessages } from "../src/agent/claude";
import { OpenWeightsProvider, toOpenAiMessages } from "../src/agent/openweights";
import { FailoverProvider } from "../src/agent/providers";
import { ProviderError, type CanonMessage, type ModelProvider } from "../src/agent/provider";

const hist: CanonMessage[] = [
  { role: "user", text: "go" },
  { role: "assistant", text: "calling", toolCalls: [{ id: "t1", name: "load_tender", args: { tender_id: "X" } }] },
  { role: "tool", results: [{ id: "t1", name: "load_tender", content: "{}", isError: false }] },
];

test("canonical -> Anthropic keeps tool_use/tool_result pairing", () => {
  const m: any[] = toAnthropicMessages(hist);
  assert.equal(m[1].content[1].type, "tool_use"); assert.equal(m[2].content[0].type, "tool_result"); assert.equal(m[2].content[0].tool_use_id, "t1");
});
test("canonical -> OpenAI-compatible tool_calls/tool messages", () => {
  const m = toOpenAiMessages("sys", hist);
  assert.equal(m[0].role, "system"); assert.equal(m[2].tool_calls[0].function.name, "load_tender"); assert.equal(m[3].role, "tool"); assert.equal(m[3].tool_call_id, "t1");
});
test("OpenWeightsProvider refuses to run unconfigured (no fake implementation)", () => {
  const saved = { u: process.env.OPENWEIGHTS_ENDPOINT_URL, m: process.env.OPENWEIGHTS_MODEL }; delete process.env.OPENWEIGHTS_ENDPOINT_URL; delete process.env.OPENWEIGHTS_MODEL;
  assert.throws(() => new OpenWeightsProvider(), (e: any) => e instanceof ProviderError && e.kind === "not_configured");
  if (saved.u) process.env.OPENWEIGHTS_ENDPOINT_URL = saved.u; if (saved.m) process.env.OPENWEIGHTS_MODEL = saved.m;
});
test("OpenWeightsProvider parses tool calls from a stubbed OpenAI-style response; bad JSON args -> invalid", async () => {
  const ok = (body: any) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const good = new OpenWeightsProvider({ url: "http://x/v1", model: "m", fetchImpl: ok({ choices: [{ message: { content: "", tool_calls: [{ id: "a", function: { name: "ingest_bid", arguments: '{"bid_id":"BID-1"}' } }] }, finish_reason: "tool_calls" }] }) });
  const r = await good.step({ system: "s", messages: [{ role: "user", text: "x" }], tools: [] });
  assert.equal(r.toolCalls[0].name, "ingest_bid"); assert.deepEqual(r.toolCalls[0].args, { bid_id: "BID-1" });
  const bad = new OpenWeightsProvider({ url: "http://x/v1", model: "m", fetchImpl: ok({ choices: [{ message: { content: "", tool_calls: [{ id: "a", function: { name: "ingest_bid", arguments: "{oops" } }] } }] }) });
  await assert.rejects(bad.step({ system: "s", messages: [], tools: [] }), (e: any) => e.kind === "invalid");
});
test("failover switches only on transient infrastructure errors", async () => {
  const mk = (id: string, err?: ProviderError): ModelProvider => ({ id, model: id, actor: id, step: async () => { if (err) throw err; return { text: id, toolCalls: [] }; } });
  const f = new FailoverProvider(mk("a", new ProviderError("slow down", "rate_limit")), mk("b"));
  assert.equal((await f.step({ system: "", messages: [], tools: [] })).text, "b"); assert.equal(f.actor, "b");
  const g = new FailoverProvider(mk("a", new ProviderError("bad key", "auth")), mk("b"));
  await assert.rejects(g.step({ system: "", messages: [], tools: [] }));
});
