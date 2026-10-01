import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env";
import { ProviderError, type CanonMessage, type ModelProvider, type StepInput, type StepOutput } from "./provider";

/** Canonical -> Anthropic Messages API. Exported for unit testing (no network needed). */
export function toAnthropicMessages(msgs: CanonMessage[]): Anthropic.MessageParam[] {
  return msgs.map((m): Anthropic.MessageParam => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      return { role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no output)" }] };
    }
    return { role: "user", content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })) };
  });
}

export class ClaudeProvider implements ModelProvider {
  readonly id = "claude";
  readonly model: string;
  readonly actor: string;
  private client: Anthropic;
  constructor(model = env.claudeModel, apiKey = env.anthropicKey) {
    if (!apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not set", "not_configured");
    this.model = model; this.actor = `claude:${model}`;
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }
  async step(input: StepInput): Promise<StepOutput> {
    try {
      const res = await this.client.messages.create({
        model: this.model, max_tokens: input.maxTokens ?? 1500, system: input.system,
        tools: input.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as any })),
        messages: toAnthropicMessages(input.messages),
      });
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const toolCalls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));
      return { text, toolCalls, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens }, stopReason: res.stop_reason ?? undefined };
    } catch (e: any) {
      const status = e?.status as number | undefined;
      const ra = Number(e?.headers?.["retry-after"]) * 1000 || undefined;
      if (status === 429) throw new ProviderError(e.message, "rate_limit", ra);
      if (status === 529 || (status && status >= 500)) throw new ProviderError(e.message, "overloaded", ra);
      if (status === 401 || status === 403) throw new ProviderError(e.message, "auth");
      if (/timeout|timed out|ETIMEDOUT/i.test(e?.message ?? "")) throw new ProviderError(e.message, "timeout");
      throw new ProviderError(e?.message ?? String(e), "other");
    }
  }
}
