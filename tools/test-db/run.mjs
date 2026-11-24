/**
 * בדיקות מסד נתונים מול PostgreSQL אמיתי ומקומי (embedded-postgres), בלי Docker ובלי שום מסד מרוחק.
 *
 *   npm --prefix tools/test-db ci      (פעם אחת: מתקין את Postgres המקומי, רק בתיקייה הזו)
 *   npm run test:db                     (כל חבילות בדיקות המסד)
 *   npm run test:db -- packages         (רק חבילות שהשם שלהן מכיל "packages")
 *
 * מה קורה: Postgres עולה בתיקייה זמנית, בפורט פנוי ועם סיסמה אקראית, רק על localhost. לכל חבילת בדיקות נוצר מסד נפרד
 * בשם *_test (שומרי הבטיחות בבדיקות דורשים מארח מקומי ושם כזה), מוחלות עליו כל המיגרציות, והבדיקות רצות. בסוף השרת
 * נעצר והתיקייה נמחקת. אין קריאה ל-DATABASE_URL של הסביבה ואין שליחת מיילים (SMTP_HOST מוסר).
 */
import EmbeddedPostgres from "embedded-postgres";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** משתנה הסביבה של כל חבילה -> קובצי הבדיקה שקוראים אותו */
const SUITES = {
  TEST_DATABASE_URL: { db: "clinics_booking_test", files: ["src/lib/booking.concurrency.test.ts"] },
  PAYMENTS_TEST_DATABASE_URL: { db: "clinics_payments_test", files: ["src/lib/payments/booking-payment.test.ts"] },
  PACKAGES_TEST_DATABASE_URL: { db: "clinics_packages_test", files: ["src/lib/payments/packages.test.ts"] },
  SAVEDCARD_TEST_DATABASE_URL: { db: "clinics_savedcard_test", files: ["src/lib/payments/saved-card.test.ts"] },
  FINANCE_TEST_DATABASE_URL: { db: "clinics_finance_test", files: ["src/lib/finance/finance.test.ts"] },
  SHIFTS_TEST_DATABASE_URL: { db: "clinics_shifts_test", files: ["src/lib/shifts/shifts.test.ts"] },
  PIN_TEST_DATABASE_URL: { db: "clinics_pin_test", files: ["src/lib/ivr-pin/ivr-pin.test.ts"] },
  IVR_TEST_DATABASE_URL: { db: "clinics_ivr_test", files: ["src/ivr/booking-flow.http.test.ts"] },
  IVRPAY_TEST_DATABASE_URL: { db: "clinics_ivrpay_test", files: ["src/ivr/payment-flow.http.test.ts"] },
};

const filters = process.argv.slice(2).map((s) => s.toLowerCase());
const selected = Object.entries(SUITES).filter(
  ([name, s]) => filters.length === 0 || filters.some((f) => name.toLowerCase().includes(f) || s.files.some((file) => file.toLowerCase().includes(f)))
);
if (selected.length === 0) {
  console.error(`[test-db] אין חבילה שמתאימה ל: ${filters.join(", ")}`);
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const password = randomBytes(16).toString("hex");
const dataDir = mkdtempSync(path.join(tmpdir(), "caps-test-pg-"));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password, port, persistent: false, onLog: () => {} });
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  // סביבה נקייה לבדיקות: בלי חיבור מסד של הסביבה ובלי SMTP
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.SMTP_HOST;
  for (const [name, suite] of selected) {
    await pg.createDatabase(suite.db);
    const url = `postgresql://postgres:${password}@localhost:${port}/${suite.db}`;
    const migrate = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: root,
      env: { ...env, DATABASE_URL: url },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (migrate.status !== 0) throw new Error(`[test-db] המיגרציות נכשלו עבור ${suite.db}`);
    env[name] = url;
  }
  console.log(`[test-db] PostgreSQL ${port} מוכן, ${selected.length} מסדי בדיקות עם כל המיגרציות`);
  const files = selected.flatMap(([, s]) => s.files);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks", "--test", ...files], { cwd: root, env, stdio: "inherit" });
  code = run.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
} finally {
  await pg.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(code);
