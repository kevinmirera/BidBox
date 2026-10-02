import { ProviderError, type CanonMessage, type ModelProvider, type StepInput, type StepOutput } from "./provider";

/**
 * OpenWeightsProvider - talks to ANY OpenAI-compatible /v1/chat/completions endpoint (vLLM, TGI,
 * Ollama, Together, a Hugging Face Inference Endpoint with the OpenAI route, ...).
 *
 * STATUS: no GPU endpoint exists yet, so this has been exercised only against a stubbed HTTP layer
 * (translation tests), never against a real open-weights model. It is NOT configured by default and
 * fails loudly with `not_configured` rather than pretending to work.
 *
 * Activate later by setting: OPENWEIGHTS_ENDPOINT_URL (base URL ending in /v1), OPENWEIGHTS_API_KEY
 * (if required) and OPENWEIGHTS_MODEL, then MODEL_PROVIDER=openweights. No graph/MCP changes needed.
 */
export const openWeightsConfigured = () => !!(process.env.OPENWEIGHTS_ENDPOINT_URL && process.env.OPENWEIGHTS_MODEL);

export function toOpenAiMessages(system: string, msgs: CanonMessage[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.text ?? null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
    else for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
  return out;
}

export class OpenWeightsProvider implements ModelProvider {
  readonly id: string;
  readonly model: string; readonly actor: string;
  private url: string; private key: string;
  private fetchImpl: typeof fetch;
  constructor(opts: { url?: string; key?: string; model?: string; fetchImpl?: typeof fetch; id?: string } = {}) {
    this.id = opts.id ?? "openweights";
    this.url = (opts.url ?? process.env.OPENWEIGHTS_ENDPOINT_URL ?? "").replace(/\/$/, "");
    this.key = opts.key ?? process.env.OPENWEIGHTS_API_KEY ?? "";
    this.model = opts.model ?? process.env.OPENWEIGHTS_MODEL ?? "";
    this.actor = `${this.id}:${this.model || "unconfigured"}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (!this.url || !this.model) throw new ProviderError(this.id === "openai" ? "OpenAI is not configured. Set OPENAI_API_KEY and OPENAI_MODEL." : "OpenWeightsProvider is not configured. Set OPENWEIGHTS_ENDPOINT_URL and OPENWEIGHTS_MODEL (and OPENWEIGHTS_API_KEY if your endpoint needs one).", "not_configured");
  }
  async step(input: StepInput): Promise<StepOutput> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify({ model: this.model, ...(this.id === "openai" ? { max_completion_tokens: input.maxTokens ?? 1500 } : { max_tokens: input.maxTokens ?? 1500, temperature: 0 }), messages: toOpenAiMessages(input.system, input.messages),
          ...(input.tools.length ? { tools: input.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } })) } : {}) }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e: any) { throw new ProviderError(e?.message ?? String(e), /timeout|abort/i.test(e?.name + e?.message) ? "timeout" : "other"); }
    if (res.status === 429) throw new ProviderError("rate limited", "rate_limit", Number(res.headers.get("retry-after")) * 1000 || undefined);
    if (res.status >= 500) throw new ProviderError(`endpoint error ${res.status}`, "overloaded");
    if (!res.ok) throw new ProviderError(`endpoint error ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status === 401 ? "auth" : "other");
    const j: any = await res.json();
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new ProviderError("malformed response (no choices[0].message)", "invalid");
    const toolCalls = (msg.tool_calls ?? []).map((c: any) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch { throw new ProviderError(`model produced invalid JSON tool arguments for ${c.function?.name}`, "invalid"); }
      return { id: c.id, name: c.function?.name, args };
    });
    return { text: msg.content ?? "", toolCalls, usage: { input: j.usage?.prompt_tokens, output: j.usage?.completion_tokens }, stopReason: j.choices[0].finish_reason };
  }
}
