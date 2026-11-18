import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStagingUrl,
  isExemptPath,
  isKnownNonProductionHost,
  isServiceKeyAllowedPath,
  isStagingGateActive,
  isStagingGateConfigured,
  isValidServiceKey,
  LOGIN_PAGE_PATH,
  MIN_PASSWORD_LENGTH,
  MIN_SERVICE_KEY_LENGTH,
  resolveTrustedPublicOrigin,
  SERVICE_KEY_ALLOWED_PATHS,
  type StagingGateEnv,
} from "@/lib/staging-gate/config";

const PROD_HOST = "capsula.example.com"; // דומיין Production דמיוני, ודאי שאינו ברשימת Staging הידועה
const STAGING_HOST = "caps-staging-ppb1.onrender.com";

// בפריסה אמיתית ב-Render, RENDER_EXTERNAL_HOSTNAME מוזרק אוטומטית ע"י ה-platform ומשקף את המארח האמיתי
// של השירות - זה מה שקובע את הזהות, לא כותרת Host של הבקשה (ראו הבדיקה הייעודית לכך למטה)
const goodEnv: StagingGateEnv = {
  STAGING_GATE_ENABLED: "true",
  STAGING_GATE_PASSWORD: "a".repeat(MIN_PASSWORD_LENGTH),
  RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
};

test("כבוי כברירת מחדל: בלי אף משתנה סביבה, אין תצורה תקינה ואין הפעלה בשום מארח", () => {
  assert.equal(isStagingGateConfigured({}), false);
  assert.equal(isStagingGateActive(STAGING_HOST, {}), false);
  assert.equal(isStagingGateActive(PROD_HOST, {}), false);
  assert.equal(isStagingGateActive("localhost", {}), false);
});

test("תצורה חסרה: בלי STAGING_GATE_ENABLED=true, או סיסמה חסרה/קצרה מדי - לא פעיל", () => {
  assert.equal(isStagingGateConfigured({ STAGING_GATE_PASSWORD: "a".repeat(MIN_PASSWORD_LENGTH) }), false, "בלי הדגל");
  assert.equal(isStagingGateConfigured({ STAGING_GATE_ENABLED: "true" }), false, "בלי סיסמה");
  assert.equal(
    isStagingGateConfigured({ STAGING_GATE_ENABLED: "true", STAGING_GATE_PASSWORD: "a".repeat(MIN_PASSWORD_LENGTH - 1) }),
    false,
    "סיסמה קצרה מדי"
  );
  assert.equal(isStagingGateConfigured({ STAGING_GATE_ENABLED: "yes", STAGING_GATE_PASSWORD: "a".repeat(20) }), false, "רק הערך המדויק true מפעיל");
});

test("תצורה תקינה כש-RENDER_EXTERNAL_HOSTNAME משקף את מארח Staging הידוע: פעיל", () => {
  assert.equal(isStagingGateActive(STAGING_HOST, goodEnv), true);
  assert.equal(
    isStagingGateActive(STAGING_HOST, { ...goodEnv, RENDER_EXTERNAL_HOSTNAME: "Caps-Staging-Ppb1.onrender.com" }),
    true,
    "לא תלוי רישיות"
  );
});

test("פיתוח מקומי (אין בכלל RENDER_EXTERNAL_HOSTNAME): נופל חזרה ל-hostname של הבקשה, מוגבל ל-localhost", () => {
  const localEnv: StagingGateEnv = { STAGING_GATE_ENABLED: "true", STAGING_GATE_PASSWORD: "a".repeat(MIN_PASSWORD_LENGTH) };
  assert.equal(isStagingGateActive("localhost", localEnv), true);
  assert.equal(isStagingGateActive("127.0.0.1:3000", localEnv), true, "כולל פורט");
  assert.equal(isStagingGateActive(STAGING_HOST, localEnv), false, "ה-hostname של הבקשה לבדו לא מספיק בלי RENDER_EXTERNAL_HOSTNAME");
});

test("הגנה מהפעלה בטעות ב-Production: גם אם משתני הסיסמה הועתקו בטעות, RENDER_EXTERNAL_HOSTNAME האמיתי של Production לא ברשימה - לא פעיל", () => {
  const accidentallyCopiedToProd: StagingGateEnv = { ...goodEnv, RENDER_EXTERNAL_HOSTNAME: PROD_HOST };
  assert.equal(isStagingGateActive(STAGING_HOST, accidentallyCopiedToProd), false);
  assert.equal(isKnownNonProductionHost(STAGING_HOST, accidentallyCopiedToProd), false);
});

test("עמידות בפני זיוף כותרת Host: hostname של הבקשה לא משפיע כשיש RENDER_EXTERNAL_HOSTNAME אמיתי", () => {
  // תוקף ששולח בקשה ל-Staging האמיתי עם כותרת Host מזויפת לא יכול "לכבות" את השער
  assert.equal(isStagingGateActive("evil-attacker-controlled-host.com", goodEnv), true, "השער נשאר פעיל ב-Staging האמיתי");
  // וגם לא יכול "להדליק" את השער ב-Production ע"י זיוף הכותרת למארח Staging הידוע
  const prodEnv: StagingGateEnv = { ...goodEnv, RENDER_EXTERNAL_HOSTNAME: PROD_HOST };
  assert.equal(isStagingGateActive(STAGING_HOST, prodEnv), false, "זיוף הכותרת לא מפעיל את השער ב-Production");
});

test("STAGING_GATE_EXTRA_HOSTS מרחיב את הרשימה (לפי RENDER_EXTERNAL_HOSTNAME), אבל רק למארחים שהוגדרו במפורש", () => {
  const baseEnv: StagingGateEnv = { ...goodEnv, STAGING_GATE_EXTRA_HOSTS: "staging2.example.com, staging3.example.com" };
  assert.equal(isStagingGateActive(STAGING_HOST, { ...baseEnv, RENDER_EXTERNAL_HOSTNAME: "staging2.example.com" }), true);
  assert.equal(isStagingGateActive(STAGING_HOST, { ...baseEnv, RENDER_EXTERNAL_HOSTNAME: "STAGING3.example.com" }), true);
  assert.equal(isStagingGateActive(STAGING_HOST, { ...baseEnv, RENDER_EXTERNAL_HOSTNAME: PROD_HOST }), false, "לא נכנס לרשימה רק כי ההרחבה קיימת");
});

test("נתיבי התחברות השער ונכסי מותג ציבוריים תמיד פטורים; כל השאר לא", () => {
  assert.equal(isExemptPath("/staging-login"), true);
  assert.equal(isExemptPath("/api/staging-gate/login"), true);
  assert.equal(isExemptPath("/brand/logo-mark.png"), true);
  assert.equal(isExemptPath("/"), false);
  assert.equal(isExemptPath("/api/payments/webhook/grow"), false);
  assert.equal(isExemptPath("/admin"), false);
});

test("מפתח שירות תקף רק מעל האורך המינימלי", () => {
  assert.equal(isValidServiceKey({}), false);
  assert.equal(isValidServiceKey({ STAGING_GATE_SERVICE_KEY: "short" }), false);
  assert.equal(isValidServiceKey({ STAGING_GATE_SERVICE_KEY: "k".repeat(MIN_SERVICE_KEY_LENGTH) }), true);
});

test("רשימת הנתיבים המורשים למפתח שירות ריקה כרגע בכוונה - אין עדיין נתיב Make מאושר", () => {
  assert.deepEqual(SERVICE_KEY_ALLOWED_PATHS, []);
  assert.equal(isServiceKeyAllowedPath("/api/payments/webhook/grow"), false);
  assert.equal(isServiceKeyAllowedPath("/admin"), false);
  assert.equal(isServiceKeyAllowedPath("/"), false);
});

test("מפתח שירות מורשה רק לנתיבי API ספציפיים שהוגדרו במפורש - לעולם לא לעמודי אתר או לניהול", () => {
  const makePaths = [/^\/api\/payments\/grow-link(\/|$)/];
  assert.equal(isServiceKeyAllowedPath("/api/payments/grow-link", makePaths), true);
  assert.equal(isServiceKeyAllowedPath("/api/payments/grow-link/123", makePaths), true);
  assert.equal(isServiceKeyAllowedPath("/admin", makePaths), false, "מפתח השירות לא פותח את אזור הניהול");
  assert.equal(isServiceKeyAllowedPath("/", makePaths), false, "מפתח השירות לא פותח עמודי אתר");
  assert.equal(isServiceKeyAllowedPath("/api/payments/other-route", makePaths), false, "לא נתיב API אחר שלא אושר במפורש");
});

test("תקלת ה-Proxy של Render: גם כש-request.url פנימי (localhost:10000), המקור הציבורי נבנה מ-RENDER_EXTERNAL_HOSTNAME", () => {
  const internalRequestUrl = "http://localhost:10000/api/staging-gate/login";
  assert.equal(resolveTrustedPublicOrigin(goodEnv, internalRequestUrl), `https://${STAGING_HOST}`);
  const url = buildStagingUrl(LOGIN_PAGE_PATH, goodEnv, internalRequestUrl);
  assert.equal(url.origin, `https://${STAGING_HOST}`, "ההפניה חייבת להצביע על הכתובת הציבורית, לא על localhost:10000");
  assert.equal(url.pathname, LOGIN_PAGE_PATH);
});

test("פיתוח מקומי (אין RENDER_EXTERNAL_HOSTNAME): המקור נגזר מ-request.url, כי אין Proxy באמצע", () => {
  const localEnv: StagingGateEnv = { STAGING_GATE_ENABLED: "true", STAGING_GATE_PASSWORD: "a".repeat(MIN_PASSWORD_LENGTH) };
  assert.equal(resolveTrustedPublicOrigin(localEnv, "http://localhost:3000/admin"), "http://localhost:3000");
});

test("buildStagingUrl חסין בפני Open Redirect: נתיב שהוא בעצמו כתובת מוחלטת לא 'בורח' מהמקור המהימן", () => {
  const url = buildStagingUrl("https://evil-attacker.example/phish", goodEnv, "http://localhost:10000/x");
  assert.equal(url.origin, `https://${STAGING_HOST}`, "חוזר למקור המהימן, לא לכתובת החיצונית");
  assert.notEqual(url.hostname, "evil-attacker.example");
});
