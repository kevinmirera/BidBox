/**
 * Deterministic calibration ("secretary-inspired") engine. NO LLM, NO I/O.
 *
 * What it is: an EXPERIMENTAL investigation-allocation mechanism. The first ~1/e (36.8%) of bids, in
 * submission order, are used only to learn tender-specific reference distributions. They are NOT
 * rejected, NOT ranked and NOT treated as losers. Later bids are compared against that reference to
 * decide WHICH FINDINGS DESERVE DEEPER INVESTIGATION.
 *
 * What it is NOT: a procurement rule, a legal threshold, a scoring formula or a way to pick a winner.
 * The classical secretary problem's 37% rule maximises the chance of selecting the single best
 * candidate under strong assumptions (random order, immediate irrevocable decisions). Here it is only
 * a heuristic for how much data to see before judging "unusual". It selects nothing.
 */

export const CALIBRATION_FRACTION = 1 / Math.E; // ~0.3679
export const MIN_STABLE_N = 5;                  // minimum calibration bids before provisional use
export const STABLE_THRESHOLD = 0.8;
export const Z_TRIGGER = 2.5;                   // robust z-score that triggers investigation
export const PCT_TRIGGER = 0.25;                // |relative deviation from median| that triggers investigation

export const calibrationSize = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * CALIBRATION_FRACTION)));

export type Observation = {
  ref: string; seq: number;
  price_usd: number | null; delivery_days: number | null;
  doc_completeness: number; technical_compliance: number | null;
};
export type Dist = { n: number; median: number; scale: number; min: number; max: number };
export type Reference = Partial<Record<"price_usd" | "delivery_days" | "doc_completeness" | "technical_compliance", Dist>>;

export const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (a: number[]) => { const m = median(a); return median(a.map((x) => Math.abs(x - m))); };
const r = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Robust scale = max(1.4826*MAD, 5% of |median|). The floor stops a tight cluster producing absurd z-scores. */
export function dist(values: number[], ratio = false): Dist | undefined {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return undefined;
  const m = median(v);
  const scale = ratio ? 0.1 : Math.max(1.4826 * mad(v), 0.05 * Math.abs(m), 1e-9);
  return { n: v.length, median: r(m, 4), scale: r(scale, 4), min: Math.min(...v), max: Math.max(...v) };
}

export function buildReference(obs: Observation[]): Reference {
  const pick = (k: "price_usd" | "delivery_days" | "doc_completeness" | "technical_compliance"): number[] =>
    obs.map((o) => o[k]).filter((x): x is number => typeof x === "number");
  return {
    price_usd: dist(pick("price_usd")),
    delivery_days: dist(pick("delivery_days")),
    doc_completeness: dist(pick("doc_completeness"), true),
    technical_compliance: dist(pick("technical_compliance"), true),
  };
}

/** Stability in [0,1]: how much the reference would move if any single calibration bid were removed. */
export function stability(obs: Observation[]): number {
  const n = obs.length;
  if (n < 3) return 0;
  const parts: number[] = [];
  for (const k of ["price_usd", "delivery_days"] as const) {
    const vals: number[] = obs.map((o) => o[k]).filter((x): x is number => typeof x === "number");
    if (vals.length < 3) continue;
    const d = dist(vals)!;
    let worst = 0;
    for (let i = 0; i < vals.length; i++) {
      const loo = vals.filter((_, j) => j !== i);
      worst = Math.max(worst, Math.abs(median(loo) - d.median));
    }
    parts.push(1 - Math.min(1, worst / d.scale));
  }
  if (!parts.length) return 0;
  const base = parts.reduce((a, b) => a + b, 0) / parts.length;
  return r(base * Math.min(1, n / MIN_STABLE_N), 3);
}

export type Phase = "OBSERVING" | "CALIBRATING" | "PROVISIONAL" | "CALIBRATED";
export function phaseOf(nInSet: number, size: number, stab: number): Phase {
  if (nInSet === 0) return "OBSERVING";
  if (nInSet >= size) return "CALIBRATED";
  if (nInSet >= MIN_STABLE_N && stab >= STABLE_THRESHOLD) return "PROVISIONAL";
  return "CALIBRATING";
}

export function deviation(value: number | null, d?: Dist) {
  if (value == null || !d) return null;
  return { value, reference_median: d.median, deviation_pct: r((value - d.median) / d.median, 4), robust_z: r((value - d.median) / d.scale, 2) };
}
export const exceeds = (dv: ReturnType<typeof deviation>) =>
  !!dv && (Math.abs(dv.robust_z) >= Z_TRIGGER || Math.abs(dv.deviation_pct) >= PCT_TRIGGER);
