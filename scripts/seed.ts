/** npm run seed -> inserts the synthetic demo tender + 20 bids into DATABASE_URL. Idempotent. */
import { getDb } from "../src/lib/db";
import { seedDemo } from "../src/demo/seed";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(1); }
getDb().then((d) => seedDemo((s, p) => d.query(s, p))).then((r) => { console.log(r); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
