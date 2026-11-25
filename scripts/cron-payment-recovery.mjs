/**
 * הפעלת התאוששות תשלומים ממתינים (נקרא ממתזמן, למשל Render Cron Job כל 10-15 דקות). אין כאן לוגיקה עסקית: רק קריאה
 * מאומתת ל-POST /api/cron/payment-recovery. הריצה בשרת אידמפוטנטית (אותו אימות וזיכוי חד-פעמי כמו התראת Grow),
 * ולכן ניסיון חוזר או הפעלה כפולה בטוחים.
 *
 * משתני סביבה: SITE_URL (כתובת האתר, ללא סלאש בסוף), CRON_SECRET (אותו סוד כמו בשירות האתר).
 * ב-Staging בלבד: STAGING_GATE_SERVICE_KEY (אותו ערך כמו בשירות ה-Staging) כדי לעבור את שער ה-Staging.
 *
 * קוד יציאה: 0 = הריצה הושלמה (גם אם חלק מהתשלומים עדיין ממתינים או שהאימות לא היה זמין זמנית - ינוסו שוב);
 *            1 = שגיאת HTTP, תשובה לא תקינה או חריגת זמן. הסודות לעולם אינם מודפסים.
 */
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET ?? "";
const SERVICE_KEY = process.env.STAGING_GATE_SERVICE_KEY ?? "";
const TIMEOUT_MS = Number(process.env.CRON_TIMEOUT_MS ?? 120_000);
const ATTEMPTS = 3;

if (!/^https?:\/\//.test(SITE_URL) || SECRET.length < 24) {
  console.error("[cron] חסרים או לא תקינים: SITE_URL (כתובת מלאה) ו-CRON_SECRET (לפחות 24 תווים)");
  process.exit(1);
}

async function callOnce() {
  const headers = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
  if (SERVICE_KEY) headers["x-staging-service-key"] = SERVICE_KEY;
  const res = await fetch(`${SITE_URL}/api/cron/payment-recovery`, {
    method: "POST",
    headers,
    body: "{}",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // תשובה שאינה JSON (דף שגיאה או הפניה לשער ה-Staging): תטופל כשגיאה
  }
  return { status: res.status, body };
}

let last = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    last = await callOnce();
    // 3xx/4xx = תצורה שגויה (שער/סוד): ניסיון חוזר לא יעזור. 5xx/רשת (כולל שרת רדום שמתעורר): ננסה שוב
    if (last.status < 500) break;
    console.error(`[cron] ניסיון ${attempt}: HTTP ${last.status}`);
  } catch (err) {
    last = null;
    console.error(`[cron] ניסיון ${attempt}: ${err instanceof Error ? err.name : "error"}`);
  }
  if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 5_000 * attempt));
}

if (!last) {
  console.error("[cron] הכישלון נמשך: אין תשובה מהשרת");
  process.exit(1);
}
const { status, body } = last;
if (status !== 200 || body?.status !== "DONE") {
  const hint =
    status === 307 || status === 302 ? " (שער ה-Staging: חסר או שגוי STAGING_GATE_SERVICE_KEY)"
    : status === 404 ? " (אין ספק תשלום פעיל או CRON_SECRET חסר/קצר בשרת)"
    : status === 401 ? " (CRON_SECRET שגוי)"
    : "";
  console.error(`[cron] נכשל: HTTP ${status}${hint}`);
  process.exit(1);
}
const outcomes = Object.entries(body.outcomes ?? {}).map(([k, v]) => `${k}:${v}`).join(",") || "-";
console.log(
  `[cron] התאוששות הושלמה: נסרקו ${body.scanned}, נבדקו ${body.checked}, בהשהיה ${body.skippedBackoff}, ללא מזהה ${body.skippedNoRef}, ` +
    `אימות לא זמין ${body.transientFailures}, שגיאות ${body.errors}, תוצאות ${outcomes}`
);
