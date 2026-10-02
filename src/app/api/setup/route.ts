import { NextResponse } from "next/server";
import { adminAuth } from "../../../lib/auth";
import { getDb } from "../../../lib/db";
import { seedDemo } from "../../../demo/seed";
import { seedOpenData } from "../../../demo/opendata";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * One-click setup for people who do not use a terminal: creates the tables (if missing) and loads the
 * synthetic demo tender + 20 bids (if not already loaded). Safe to call repeatedly. Protected by ADMIN_API_TOKEN.
 */
export async function POST(req: Request) {
  const denied = adminAuth(req); if (denied) return denied;
  try {
    const d = await getDb(); // creates the schema if missing
    const r = await seedDemo((sql, params) => d.query(sql, params));
    let open: any;
    try { open = await seedOpenData((sql, params) => d.query(sql, params)); } catch (e: any) { open = { seeded: false, error: e.message }; }
    return NextResponse.json({ ok: true, database: d.kind, ...r, open_data: open });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
