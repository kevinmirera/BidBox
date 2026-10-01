/** npm run migrate  -> applies db/migrations/*.sql to DATABASE_URL (Supabase). Idempotent. */
import { getDb } from "../src/lib/db";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set. Refusing to 'migrate' the throw-away in-memory database."); process.exit(1); }
getDb().then(() => { console.log("migrations applied"); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
