import { NextResponse } from "next/server";
import { z } from "zod";
import { adminAuth } from "../../../lib/auth";
import { searchProcurements } from "../../../domain/market";

export const runtime = "nodejs";
const Body = z.object({ keyword: z.string().min(2).max(60), country: z.string().regex(/^[A-Za-z]{2,3}$/).optional(), limit: z.number().int().min(3).max(100).optional() });

/** Direct (no-model) search over the shared open contracting data, with 37% calibration. */
export async function POST(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid request", issues: p.error.issues }, { status: 400 });
  try { return NextResponse.json(await searchProcurements(p.data)); } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
