/**
 * Model-independent contract. The LangGraph workflow depends ONLY on ModelProvider.
 * Conversation history is kept in a neutral "canonical" shape; each provider translates at its edge.
 */
export type ToolDef = { name: string; description?: string; inputSchema: Record<string, any> };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ToolResult = { id: string; name: string; content: string; isError: boolean };
export type CanonMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export type StepInput = { system: string; messages: CanonMessage[]; tools: ToolDef[]; maxTokens?: number };
export type StepOutput = { text: string; toolCalls: ToolCall[]; usage?: { input?: number; output?: number }; stopReason?: string };

export interface ModelProvider {
  readonly id: "claude" | "openweights" | string;
  readonly model: string;
  /** identity string written to every audit record */
  readonly actor: string;
  step(input: StepInput): Promise<StepOutput>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly kind: "rate_limit" | "overloaded" | "timeout" | "auth" | "invalid" | "not_configured" | "other", public readonly retryAfterMs?: number) { super(message); }
  get transient() { return this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "timeout"; }
}
