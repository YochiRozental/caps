import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "@/app/api/staging-gate/login/route";
import { GATE_COOKIE_NAME, MIN_PASSWORD_LENGTH } from "@/lib/staging-gate/config";

const STAGING_HOST = "caps-staging-ppb1.onrender.com";
const PASSWORD = "correct-horse-battery-staple"; // מעל המינימום

const ENV_KEYS = ["STAGING_GATE_ENABLED", "STAGING_GATE_PASSWORD", "RENDER_EXTERNAL_HOSTNAME"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setActiveStagingEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STAGING_GATE_ENABLED = "true";
  process.env.STAGING_GATE_PASSWORD = PASSWORD;
  process.env.RENDER_EXTERNAL_HOSTNAME = STAGING_HOST;
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/**
 * מדמה את מה שבאמת מגיע לשרת מאחורי ה-Proxy הפנימי של Render: הכתובת שבה request.url/Host משתמשים היא
 * כתובת פנימית (localhost:10000), לא הכתובת הציבורית. זו הייתה התקלה בפועל - בודקים שההפניה בכל זאת
 * מצביעה על הכתובת הציבורית האמיתית (RENDER_EXTERNAL_HOSTNAME), ולא על הכתובת הפנימית הזו.
 */
function loginRequest(form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return new Request("http://localhost:10000/api/staging-gate/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

test("סיסמה שגויה: מפנה ל-staging-login?error=1 בכתובת הציבורית, לא ל-localhost:10000 (תקלת ה-Proxy)", async () => {
  setActiveStagingEnv();
  try {
    const res = await POST(loginRequest({ password: "wrong-password-0123456789", next: "/admin" }));
    assert.equal(res.status, 303);
    const location = res.headers.get("Location")!;
    assert.ok(location.startsWith(`https://${STAGING_HOST}/staging-login?`), `הכתובת צריכה להיות הציבורית: ${location}`);
    assert.ok(!location.includes("localhost"), `אסור שההפניה תכיל כתובת פנימית: ${location}`);
    const url = new URL(location);
    assert.equal(url.searchParams.get("error"), "1");
    assert.equal(url.searchParams.get("next"), "/admin");
    assert.equal(res.headers.get("Set-Cookie"), null, "סיסמה שגויה - אסור שתונפק עוגיית גישה");
  } finally {
    restoreEnv();
  }
});

test("סיסמה נכונה: מפנה ל-next בכתובת הציבורית, לא ל-localhost:10000, ומנפיק עוגיית גישה מאובטחת", async () => {
  setActiveStagingEnv();
  try {
    const res = await POST(loginRequest({ password: PASSWORD, next: "/admin" }));
    assert.equal(res.status, 303);
    const location = res.headers.get("Location")!;
    assert.equal(location, `https://${STAGING_HOST}/admin`);

    const setCookie = res.headers.get("Set-Cookie")!;
    assert.ok(setCookie.startsWith(`${GATE_COOKIE_NAME}=`));
    assert.ok(setCookie.includes("HttpOnly"), "העוגייה חייבת להיות HttpOnly");
    assert.ok(setCookie.includes("Secure"), "העוגייה חייבת להיות Secure");
    assert.ok(!setCookie.includes(PASSWORD), "אסור שהעוגייה תחשוף את הסיסמה עצמה");
  } finally {
    restoreEnv();
  }
});

test("next חוץ-אתרי (ניסיון Open Redirect) מתעלם ומוחלף ב-'/' - גם בהפניה המוצלחת וגם בכשלון", async () => {
  setActiveStagingEnv();
  try {
    const failRes = await POST(loginRequest({ password: "wrong", next: "https://evil.example/phish" }));
    const failUrl = new URL(failRes.headers.get("Location")!);
    assert.equal(failUrl.origin, `https://${STAGING_HOST}`);
    assert.equal(failUrl.searchParams.get("next"), "/", "next חוץ-אתרי מוחלף בנתיב הבית");

    const okRes = await POST(loginRequest({ password: PASSWORD, next: "//evil.example/phish" }));
    assert.equal(okRes.headers.get("Location"), `https://${STAGING_HOST}/`, "next יחסי-פרוטוקול (//) גם הוא מוחלף בנתיב הבית");
  } finally {
    restoreEnv();
  }
});

test("השער לא פעיל (אין תצורה): הנתיב מחזיר 404, כמו CRON_SECRET, בלי לחשוף שההגנה קיימת", async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.STAGING_GATE_ENABLED;
  delete process.env.STAGING_GATE_PASSWORD;
  delete process.env.RENDER_EXTERNAL_HOSTNAME;
  try {
    const res = await POST(loginRequest({ password: PASSWORD, next: "/" }));
    assert.equal(res.status, 404);
  } finally {
    restoreEnv();
  }
});

test("אורך סיסמה על הסף התחתון עדיין מתקבל (ללא שינוי בהתנהגות האימות עצמה)", async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STAGING_GATE_ENABLED = "true";
  process.env.STAGING_GATE_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH);
  process.env.RENDER_EXTERNAL_HOSTNAME = STAGING_HOST;
  try {
    const res = await POST(loginRequest({ password: "x".repeat(MIN_PASSWORD_LENGTH), next: "/" }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), `https://${STAGING_HOST}/`);
  } finally {
    restoreEnv();
  }
});
