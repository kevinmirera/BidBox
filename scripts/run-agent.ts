/** CLI runner: npm run run:agent -- [--provider claude|openweights|scripted] [--tender TND-2026-014] [--batch 25] */
import { runAgent } from "../src/agent/run";
import { createProvider } from "../src/agent/providers";
import { ScriptedProvider } from "../src/agent/testing";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const name = arg("provider", process.env.MODEL_PROVIDER || "claude")!;
const provider = name === "scripted" ? new ScriptedProvider() : createProvider(name);
const t0 = Date.now();
runAgent({ tenderRef: arg("tender", "TND-2026-014")!, provider, batchSize: Number(arg("batch", "25")) })
  .then((r) => { console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2)); process.exit(0); })
  .catch((e) => { console.error("RUN FAILED:", e.message); process.exit(1); });
