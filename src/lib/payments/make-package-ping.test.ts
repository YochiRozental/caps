import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  COMMUNICATION_ONLY,
  DIAG_MARKER,
  PACKAGE_PING_ID_PREFIX,
  buildPackagePingPayload,
  derivePackagePingId,
  handlePackagePing,
  isPackagePingAvailable,
  resetPackagePings,
  type PackagePingEnv,
  type PackagePingRequest,
} from "@/lib/payments/make-diagnostics";
import { deriveMakePaymentId } from "@/lib/payments/make-provider";

const WEBHOOK = "https://hook.eu1.make.com/create-secret-path-123";
const KEY = "create-key-" + "a".repeat(20);
const STAGING_HOST = "caps-staging-ppb1.onrender.com";
const PRICE = 30000;

const stagingEnv: PackagePingEnv = {
  MAKE_PACKAGE_PING_ENABLED: "true",
  STAGING_GATE_ENABLED: "true",
  STAGING_GATE_PASSWORD: "x".repeat(16),
  RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
  MAKE_PAYMENT_WEBHOOK_URL: WEBHOOK,
  MAKE_PAYMENT_API_KEY: KEY,
};

type Call = { url: string; init: RequestInit };

function setup(over: Partial<PackagePingRequest> & { body?: unknown; response?: () => Response } = {}) {
  const calls: Call[] = [];
  const { body, response, ...rest } = over;
  const req: PackagePingRequest = {
    hostname: STAGING_HOST,
    rawBody: JSON.stringify(body ?? { hours: 5, clientKey: "abcdef1234567890" }),
    env: stagingEnv,
    userId: "user_1",
    loadUser: async () => ({ role: "CLIENT", status: "APPROVED" }),
    loadPackagePriceAgorot: async (h) => (h === 5 ? PRICE : null),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response ? response() : new Response("Accepted", { status: 200 });
    }) as unknown as typeof fetch,
    ...rest,
  };
  return { req, calls };
}

beforeEach(() => resetPackagePings());

test("זמינות: רק עם הדגל, בשער Staging פעיל ו-Webhook HTTPS - לא ב-Production ולא מקומית בלי שער", () => {
  assert.equal(isPackagePingAvailable(STAGING_HOST, stagingEnv), true);
  const blocked: PackagePingEnv[] = [
    { ...stagingEnv, MAKE_PACKAGE_PING_ENABLED: undefined },
    { ...stagingEnv, MAKE_PACKAGE_PING_ENABLED: "1" },
    { ...stagingEnv, STAGING_GATE_ENABLED: undefined },
    { ...stagingEnv, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" },
    { ...stagingEnv, MAKE_PAYMENT_WEBHOOK_URL: "http://hook.eu1.make.com/x" },
    { ...stagingEnv, MAKE_PAYMENT_WEBHOOK_URL: undefined },
    { ...stagingEnv, MAKE_PAYMENT_API_KEY: undefined },
  ];
  for (const env of blocked) assert.equal(isPackagePingAvailable(STAGING_HOST, env), false);
  // כותרת Host מזויפת לא עוקפת: ב-Render ההכרעה לפי RENDER_EXTERNAL_HOSTNAME
  assert.equal(isPackagePingAvailable(STAGING_HOST, { ...stagingEnv, RENDER_EXTERNAL_HOSTNAME: "caps-prod.onrender.com" }), false);
});

test("כשהבדיקה כבויה או מחוץ ל-Staging: מחזיר null בלי שליחה (הנתיב ממשיך כרגיל)", async () => {
  for (const env of [{ ...stagingEnv, MAKE_PACKAGE_PING_ENABLED: undefined }, { ...stagingEnv, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }]) {
    const { req, calls } = setup({ env });
    assert.equal(await handlePackagePing(req), null);
    assert.equal(calls.length, 0);
  }
});

test("חבילה שאינה 5 שעות או גוף לא תקין: null, בלי שליחה", async () => {
  for (const body of [{ hours: 10, clientKey: "abcdef1234567890" }, { hours: 20 }, "not-json"]) {
    const { req, calls } = setup({ body });
    if (body === "not-json") req.rawBody = "{bad";
    assert.equal(await handlePackagePing(req), null);
    assert.equal(calls.length, 0);
  }
});

test("שליחה: כותרת המפתח, הסימונים DISCOVER ו-COMMUNICATION_ONLY, ורק השדות המותרים", async () => {
  const { req, calls } = setup();
  const res = await handlePackagePing(req);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal((calls[0].init.headers as Record<string, string>)["x-make-apikey"], KEY);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(sent).sort(), ["amount", "currency", "customerRef", "diagnostic", "hours", "purchaseId", "purchaseType", "test"].sort());
  assert.equal(sent.diagnostic, DIAG_MARKER);
  assert.equal(sent.diagnostic, "DISCOVER");
  assert.equal(sent.test, COMMUNICATION_ONLY);
  assert.equal(sent.purchaseType, "PACKAGE");
  assert.equal(sent.hours, 5);
  assert.equal(sent.customerRef, "user_1");
  assert.equal(sent.amount, "300.00");
  assert.equal(sent.purchaseId, derivePackagePingId("user_1", "abcdef1234567890"));
  assert.equal(res?.status, 202);
  assert.equal(res?.body.communicationTest, true);
  assert.equal(res?.body.outcome, "ACCEPTED_NO_RESPONSE");
});

test("מחיר מהדפדפן מתעלמים ממנו: הסכום נקבע בשרת", async () => {
  const { req, calls } = setup({ body: { hours: 5, clientKey: "abcdef1234567890", priceAgorot: 1, amount: "0.01" } });
  const res = await handlePackagePing(req);
  assert.equal(JSON.parse(String(calls[0].init.body)).amount, "300.00");
  assert.equal(res?.body.amountAgorot, PRICE);
});

test("מזהה הרכישה: קידומת נפרדת שלא תואמת מזהה תשלום אמיתי, ייחודי לכל כוונת רכישה ולכל משתמש", () => {
  const id = derivePackagePingId("user_1", "abcdef1234567890");
  assert.ok(id.startsWith(PACKAGE_PING_ID_PREFIX));
  assert.doesNotMatch(id, /^make:[0-9a-f]{32}$/);
  assert.notEqual(id, deriveMakePaymentId("package:user_1:abcdef1234567890"));
  assert.equal(id, derivePackagePingId("user_1", "abcdef1234567890"));
  assert.notEqual(id, derivePackagePingId("user_1", "abcdef1234567891"));
  assert.notEqual(id, derivePackagePingId("user_2", "abcdef1234567890"));
});

test("אין כפילות: אותו clientKey (כולל בקשות מקבילות) נשלח פעם אחת; clientKey חדש = שליחה חדשה", async () => {
  const { req, calls } = setup();
  const [a, b] = await Promise.all([handlePackagePing(req), handlePackagePing(req)]);
  await handlePackagePing(req);
  assert.equal(calls.length, 1);
  assert.equal(a?.body.purchaseId, b?.body.purchaseId);
  const other = setup({ body: { hours: 5, clientKey: "zzzzzz1234567890" } });
  other.req.fetchImpl = req.fetchImpl;
  const c = await handlePackagePing(other.req);
  assert.equal(calls.length, 2);
  assert.notEqual(c?.body.purchaseId, a?.body.purchaseId);
});

test("אחרי כשל משלוח מותר לנסות שוב עם אותו מזהה", async () => {
  let fail = true;
  const { req, calls } = setup({ response: () => new Response("", { status: fail ? 500 : 200 }) });
  assert.equal((await handlePackagePing(req))?.body.outcome, "MAKE_ERROR");
  fail = false;
  assert.equal((await handlePackagePing(req))?.body.outcome, "ACCEPTED_NO_RESPONSE");
  assert.equal(calls.length, 2);
});

test("קישור תשלום בתשובת Make לעולם לא מוחזר ללקוח, ומוצגת אזהרה", async () => {
  const { req } = setup({ response: () => new Response(JSON.stringify({ url: "https://sandbox.grow.link/secret-xyz" }), { status: 200 }) });
  const res = await handlePackagePing(req);
  assert.equal(res?.body.outcome, "SUCCESS");
  assert.ok(!JSON.stringify(res?.body).includes("secret-xyz"));
  assert.ok(Array.isArray(res?.body.warnings));
});

test("הרשאות: לא מחובר 401, לקוח לא מאושר / מנהל 403, מפתח לא תקין 400 - בלי שליחה", async () => {
  const cases: [Partial<PackagePingRequest> & { body?: unknown }, number][] = [
    [{ userId: null }, 401],
    [{ loadUser: async () => ({ role: "CLIENT", status: "PENDING" }) }, 403],
    [{ loadUser: async () => ({ role: "ADMIN", status: "APPROVED" }) }, 403],
    [{ loadUser: async () => null }, 403],
    [{ body: { hours: 5, clientKey: "short" } }, 400],
    [{ loadPackagePriceAgorot: async () => null }, 400],
  ];
  for (const [over, status] of cases) {
    const { req, calls } = setup(over);
    assert.equal((await handlePackagePing(req))?.status, status);
    assert.equal(calls.length, 0);
  }
});

test("גוף הבקשה אינו כולל פרטים אישיים או סודות", () => {
  const p = buildPackagePingPayload({ purchaseId: "commtest_x", customerRef: "user_1", amountAgorot: PRICE });
  const text = JSON.stringify(p);
  for (const k of ["fullName", "phone", "email", "card", "apiKey", "returnUrl"]) assert.ok(!text.includes(k));
  assert.ok(!text.includes(KEY));
});
