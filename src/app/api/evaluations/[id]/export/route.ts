import { NextResponse } from "next/server";
import { adminAuth } from "../../../../../lib/auth";
import { q } from "../../../../../lib/db";

export const runtime = "nodejs";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = adminAuth(req); if (denied) return denied;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const ok = await q(`SELECT 1 FROM human_approvals WHERE evaluation_id=$1 AND action='EXPORT_COMMITTEE_FILE' AND status='APPROVED' AND approver IS NOT NULL LIMIT 1`, [id]);
  if (!ok.length) return NextResponse.json({ error: "export requires human approval", status: "PENDING_HUMAN_APPROVAL" }, { status: 403 });
  const ev = (await q(`SELECT package FROM evaluations WHERE id=$1`, [id]))[0];
  if (!ev) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(JSON.stringify(ev.package, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="committee-file-${id}.json"` } });
}
