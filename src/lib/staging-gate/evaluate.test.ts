import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStagingGate } from "@/lib/staging-gate/evaluate";
import { gateCookieValue } from "@/lib/staging-gate/token";
import { MIN_PASSWORD_LENGTH, MIN_SERVICE_KEY_LENGTH, type StagingGateEnv } from "@/lib/staging-gate/config";

const STAGING_HOST = "caps-staging-ppb1.onrender.com";
const PROD_HOST = "capsula.example.com";
const PASSWORD = "correct-horse-battery-staple"; // 29 תווים, מעל המינימום
const SERVICE_KEY = "s".repeat(MIN_SERVICE_KEY_LENGTH + 5);

// RENDER_EXTERNAL_HOSTNAME - לא req.hostname - הוא מה שקובע את הזהות (ראו config.test.ts לבדיקות הממוקדות
// בכך); כאן הוא תמיד תואם את Staging האמיתי, כדי לבדוק את החלטת ה-middleware בפני בקשות (hostname/path/
// cookie/כותרת) ולא את זיהוי המארח עצמו.
const activeEnv: StagingGateEnv = {
  STAGING_GATE_ENABLED: "true",
  STAGING_GATE_PASSWORD: PASSWORD,
  STAGING_GATE_SERVICE_KEY: SERVICE_KEY,
  RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
};

test("השער לא פעיל: תמיד מותר, גם בלי שום עוגייה או מפתח (הצבה בטעות ב-Production לא תחסום אף אחד)", async () => {
  const noEnvCases: StagingGateEnv[] = [
    {}, // בלי תצורה בכלל
    { STAGING_GATE_PASSWORD: PASSWORD, RENDER_EXTERNAL_HOSTNAME: STAGING_HOST }, // בלי הדגל המפורש
    { STAGING_GATE_ENABLED: "true", STAGING_GATE_PASSWORD: "too-short", RENDER_EXTERNAL_HOSTNAME: STAGING_HOST }, // סיסמה קצרה מדי
  ];
  for (const env of noEnvCases) {
    assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin" }, env), "inactive");
  }
  // גם עם תצורה תקינה לגמרי, אם RENDER_EXTERNAL_HOSTNAME (לא הבקשה!) הוא Production - לא מופעל
  const accidentallyCopiedToProd: StagingGateEnv = { ...activeEnv, RENDER_EXTERNAL_HOSTNAME: PROD_HOST };
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin" }, accidentallyCopiedToProd), "inactive");
});

test("זיוף כותרת Host בבקשה לא יכול לכבות את השער ב-Staging האמיתי (הזהות נגזרת מ-RENDER_EXTERNAL_HOSTNAME, לא מהבקשה)", async () => {
  assert.equal(
    await decideStagingGate({ hostname: "evil-attacker-controlled-host.com", pathname: "/admin" }, activeEnv),
    "denied",
    "השער עדיין פעיל ודורש אימות, חרף כותרת Host מזויפת"
  );
});

test("נתיב ההתחברות וה-API שלו פטורים כש-השער פעיל, בלי שום אימות", async () => {
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/staging-login" }, activeEnv), "exempt");
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/api/staging-gate/login" }, activeEnv), "exempt");
});

test("בלי עוגייה ובלי מפתח שירות: נדחה", async () => {
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin" }, activeEnv), "denied");
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/api/payments/webhook/grow" }, activeEnv), "denied");
});

test("עוגייה שגויה (סיסמה שגויה בעבר, או זיוף) נדחית", async () => {
  const wrongCookie = await gateCookieValue("wrong-password-value-0123456789");
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin", cookieValue: wrongCookie }, activeEnv), "denied");
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin", cookieValue: "garbage" }, activeEnv), "denied");
});

test("עוגייה נכונה (שחושבה מהסיסמה הנכונה) מתקבלת", async () => {
  const validCookie = await gateCookieValue(PASSWORD);
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin", cookieValue: validCookie }, activeEnv), "allowed");
});

test("עוגייה שחושבה מסיסמה ישנה מפסיקה לעבוד אחרי שהסיסמה מתחלפת ב-Render", async () => {
  const oldCookie = await gateCookieValue(PASSWORD);
  const rotatedEnv: StagingGateEnv = { ...activeEnv, STAGING_GATE_PASSWORD: "a-brand-new-rotated-password" };
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin", cookieValue: oldCookie }, rotatedEnv), "denied");
});

test("כרגע (רשימת נתיבים מורשים ריקה): אפילו מפתח שירות תקין לגמרי לא פותח שום נתיב - אין עדיין נתיב Make מאושר", async () => {
  assert.equal(
    await decideStagingGate({ hostname: STAGING_HOST, pathname: "/api/payments/webhook/grow", serviceKeyHeader: SERVICE_KEY }, activeEnv),
    "denied",
    "ללא הוספת הנתיב ל-SERVICE_KEY_ALLOWED_PATHS, המפתח חסום בכוונה"
  );
});

test("מפתח שירות נכון בכותרת מתקבל בלי עוגייה, אך רק בנתיב שהוגדר במפורש ברשימה המורשית", async () => {
  const makePaths = [/^\/api\/payments\/grow-link(\/|$)/];
  assert.equal(
    await decideStagingGate({ hostname: STAGING_HOST, pathname: "/api/payments/grow-link", serviceKeyHeader: SERVICE_KEY }, activeEnv, makePaths),
    "allowed"
  );
});

test("מפתח שירות לא פותח נתיב שלא ברשימה המורשית, גם אם הוא תקין (למשל עמוד אתר או אזור ניהול)", async () => {
  const makePaths = [/^\/api\/payments\/grow-link(\/|$)/];
  assert.equal(
    await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin", serviceKeyHeader: SERVICE_KEY }, activeEnv, makePaths),
    "denied",
    "אין עקיפה כללית - המפתח מוגבל לנתיב הספציפי שאושר"
  );
  assert.equal(
    await decideStagingGate({ hostname: STAGING_HOST, pathname: "/", serviceKeyHeader: SERVICE_KEY }, activeEnv, makePaths),
    "denied"
  );
});

test("מפתח שירות שגוי, או קצר מדי אפילו אם מוגדר, נדחה - אין עקיפה כללית", async () => {
  const makePaths = [/^\/api\/payments\/grow-link(\/|$)/];
  assert.equal(
    await decideStagingGate({ hostname: STAGING_HOST, pathname: "/api/payments/grow-link", serviceKeyHeader: "wrong-key" }, activeEnv, makePaths),
    "denied"
  );
  const shortKeyEnv: StagingGateEnv = { ...activeEnv, STAGING_GATE_SERVICE_KEY: "short" };
  assert.equal(
    await decideStagingGate({ hostname: STAGING_HOST, pathname: "/api/payments/grow-link", serviceKeyHeader: "short" }, shortKeyEnv, makePaths),
    "denied",
    "מפתח קצר מדי לא נחשב מוגדר, גם אם הוא תואם את עצמו"
  );
});

test("בלי מפתח שירות מוגדר כלל, שום כותרת לא עוקפת את השער", async () => {
  const noServiceKeyEnv: StagingGateEnv = { STAGING_GATE_ENABLED: "true", STAGING_GATE_PASSWORD: PASSWORD, RENDER_EXTERNAL_HOSTNAME: STAGING_HOST };
  const makePaths = [/^\/api\/payments\/grow-link(\/|$)/];
  assert.equal(
    await decideStagingGate(
      { hostname: STAGING_HOST, pathname: "/api/payments/grow-link", serviceKeyHeader: "anything" },
      noServiceKeyEnv,
      makePaths
    ),
    "denied"
  );
});

test("אורך הסיסמה בדיוק על הסף התחתון עדיין נחשב תקין", async () => {
  const env: StagingGateEnv = {
    STAGING_GATE_ENABLED: "true",
    STAGING_GATE_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH),
    RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
  };
  const cookie = await gateCookieValue("x".repeat(MIN_PASSWORD_LENGTH));
  assert.equal(await decideStagingGate({ hostname: STAGING_HOST, pathname: "/admin", cookieValue: cookie }, env), "allowed");
});
