import { env } from "../lib/env";
import { ClaudeProvider } from "./claude";
import { OpenWeightsProvider } from "./openweights";
import { ProviderError, type ModelProvider, type StepInput, type StepOutput } from "./provider";

/** MODEL_PROVIDER=claude|openweights. The workflow never sees which one it got. */
export function createProvider(name = env.modelProvider): ModelProvider {
  if (name === "claude") return new ClaudeProvider();
  if (name === "openweights") return new OpenWeightsProvider();
  throw new ProviderError(`unknown MODEL_PROVIDER: ${name}`, "invalid");
}

/**
 * Optional failover: if the primary fails with a TRANSIENT infrastructure error (429/5xx/timeout)
 * after the SDK's own retries, the same step is retried on the secondary. Never switches on content.
 */
export class FailoverProvider implements ModelProvider {
  readonly id: string; readonly model: string; actor: string;
  active: ModelProvider;
  constructor(private primary: ModelProvider, private secondary: ModelProvider) { this.id = primary.id; this.model = primary.model; this.actor = primary.actor; this.active = primary; }
  async step(i: StepInput): Promise<StepOutput> {
    try { return await this.active.step(i); }
    catch (e) {
      if (this.active === this.primary && e instanceof ProviderError && e.transient) { this.active = this.secondary; this.actor = this.secondary.actor; return this.secondary.step(i); }
      throw e;
    }
  }
}
