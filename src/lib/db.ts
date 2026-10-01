import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

/**
 * Minimal Postgres access layer.
 *  - DATABASE_URL set   -> node-postgres (Supabase / any Postgres)
 *  - DATABASE_URL unset -> in-process PGlite (real Postgres compiled to WASM) for local dev & tests ONLY.
 *    PGlite is refused in production so the app can never silently run on throw-away storage.
 */
type Row = Record<string, any>;
export interface Driver {
  query(sql: string, params?: any[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  kind: "pg" | "pglite";
}

const g = globalThis as any;

async function makeDriver(): Promise<Driver> {
  if (env.databaseUrl) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: env.databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 5),
      ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl) ? undefined : { rejectUnauthorized: false },
    });
    return {
      kind: "pg",
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      exec: async (sql) => { await pool.query(sql); },
    };
  }
  if (env.isProd) throw new Error("DATABASE_URL is required in production");
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR; // optional persistence for local dev
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  return {
    kind: "pglite",
    query: async (sql, params) => (await db.query(sql, params)).rows as Row[],
    exec: async (sql) => { await db.exec(sql); },
  };
}

export async function getDb(): Promise<Driver> {
  if (!g.__bidboxDb) {
    g.__bidboxDb = (async () => {
      const d = await makeDriver();
      await runMigrations(d);
      if (d.kind === "pglite") {
        // Local convenience: auto-seed demo data so `npm run dev` shows something.
        const { seedDemo } = await import("../demo/seed");
        await seedDemo((sql, params) => d.query(sql, params));
      }
      return d;
    })();
  }
  return g.__bidboxDb;
}

export async function runMigrations(d: Driver) {
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    try {
      await d.exec(sql);
    } catch (e: any) {
      // 002_vector.sql is best-effort (pgvector may be unavailable); everything else is fatal.
      if (f.includes("vector")) console.warn(`[migrate] optional ${f} skipped: ${e.message}`);
      else throw e;
    }
  }
}

export async function q<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  const d = await getDb();
  return d.query(sql, params) as Promise<T[]>;
}
export const json = (v: unknown) => JSON.stringify(v ?? null);
