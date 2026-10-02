import { NextResponse } from "next/server";
import { adminAuth } from "../../../lib/auth";
import { env } from "../../../lib/env";
import { openWeightsConfigured } from "../../../agent/openweights";

export const runtime = "nodejs";
/** Which model providers are usable right now (booleans only; no secrets are returned). */
export async function GET(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const models = [
    { id: "claude", label: `Claude (${env.claudeModel})`, configured: !!env.anthropicKey, needs: "ANTHROPIC_API_KEY" },
    { id: "openai", label: `OpenAI (${process.env.OPENAI_MODEL || "set OPENAI_MODEL"})`, configured: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL), needs: "OPENAI_API_KEY + OPENAI_MODEL" },
    { id: "openweights", label: `Open-weights (${process.env.OPENWEIGHTS_MODEL || "not set"})`, configured: openWeightsConfigured(), needs: "OPENWEIGHTS_ENDPOINT_URL + OPENWEIGHTS_MODEL" },
    { id: "direct", label: "Direct search (no model)", configured: true, needs: "" },
    ...(env.isProd ? [] : [{ id: "scripted", label: "Test double (not an AI)", configured: true, needs: "" }]),
  ];
  return NextResponse.json({ default: env.modelProvider, models });
}
