import { NextResponse } from "next/server";
import { z } from "zod";
import { runAgent } from "../../../agent/run";
import { createProvider, FailoverProvider } from "../../../agent/providers";
import { ScriptedProvider } from "../../../agent/testing";
import { openWeightsConfigured, OpenWeightsProvider } from "../../../agent/openweights";
import { adminAuth } from "../../../lib/auth";
import { env } from "../../../lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  tender_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  run_id: z.string().uuid().optional(),
  batch_size: z.number().int().min(1).max(25).optional(),
  provider: z.enum(["claude", "openweights", "scripted"]).optional(),
  scripted_fail_after_steps: z.number().int().min(0).max(500).optional(), // test hook: simulate model outage (non-prod only)
});

export async function POST(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid request", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  if (b.provider === "scripted" && env.isProd) return NextResponse.json({ error: "scripted test provider is disabled in production" }, { status: 400 });
  try {
    let provider: any;
    if (b.provider === "scripted") provider = new ScriptedProvider(b.scripted_fail_after_steps != null ? { failAfterSteps: b.scripted_fail_after_steps } : {});
    else {
      provider = createProvider(b.provider ?? env.modelProvider);
      // optional failover Claude -> open-weights, only if an open-weights endpoint is configured
      if (provider.id === "claude" && openWeightsConfigured()) provider = new FailoverProvider(provider, new OpenWeightsProvider());
    }
    const result = await runAgent({ tenderRef: b.tender_id, provider, runId: b.run_id, batchSize: b.batch_size });
    return NextResponse.json(result);
  } catch (e: any) {
    const notConfigured = e?.kind === "not_configured";
    return NextResponse.json({ error: e?.message ?? "run failed", code: notConfigured ? "PROVIDER_NOT_CONFIGURED" : "RUN_FAILED" }, { status: notConfigured ? 424 : 500 });
  }
}
