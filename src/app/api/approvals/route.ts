import { NextResponse } from "next/server";
import { z } from "zod";
import { adminAuth } from "../../../lib/auth";
import { q } from "../../../lib/db";

export const runtime = "nodejs";
const Body = z.object({ evaluation_id: z.string().uuid(), status: z.enum(["APPROVED", "REJECTED"]), approver: z.string().min(2).max(120), note: z.string().max(1000).optional() });

/**
 * HUMAN approval gate for exporting the committee file. This is an operator API protected by ADMIN_API_TOKEN;
 * it is intentionally NOT exposed as an MCP tool, so no model can approve anything. Records are append-only.
 * Approving the EXPORT is not an award: no route or tool in Bid Box can award a tender.
 */
export async function POST(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid request", issues: p.error.issues }, { status: 400 });
  const ev = (await q(`SELECT id, tender_id FROM evaluations WHERE id=$1`, [p.data.evaluation_id]))[0];
  if (!ev) return NextResponse.json({ error: "evaluation not found" }, { status: 404 });
  const r = await q(`INSERT INTO human_approvals (tender_id, evaluation_id, action, status, approver, note) VALUES ($1,$2,'EXPORT_COMMITTEE_FILE',$3,$4,$5) RETURNING id, created_at`, [ev.tender_id, ev.id, p.data.status, p.data.approver, p.data.note ?? null]);
  return NextResponse.json({ approval_id: r[0].id, status: p.data.status, approver: p.data.approver, note: "Export approval recorded. This is not an award decision." });
}
