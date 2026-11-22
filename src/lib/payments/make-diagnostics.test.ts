import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import { MakeGrowPaymentProvider } from "@/lib/payments/make-provider";
import {
  buildCreatePayload,
  handleDiagnosticsGet,
  handleDiagnosticsPost,
  isDiagnosticsAvailable,
  resetDiagnosticsCooldown,
  type DiagEnv,
  type DiagRequest,
} from "@/lib/payments/make-diagnostics";

const CREATE_URL = "https://hook.eu1.make.com/create-secret-path-123";
const VERIFY_URL = "https://hook.eu1.make.com/verify-secret-path-456";
const CREATE_KEY = "create-key-" + "a".repeat(20);
const VERIFY_KEY = "verify-key-" + "b".repeat(20);
const STAGING_HOST = "caps-staging-ppb1.onrender.com";

const stagingEnv: DiagEnv = {
  MAKE_DIAG_ENABLED: "true",
  STAGING_GATE_ENABLED: "true",
  STAGING_GATE_PASSWORD: "x".repeat(16),
  RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
  MAKE_PAYMENT_WEBHOOK_URL: CREATE_URL,
  MAKE_PAYMENT_API_KEY: CREATE_KEY,
  MAKE_VERIFY_WEBHOOK_URL: VERIFY_URL,
  MAKE_VERIFY_API_KEY: VERIFY_KEY,
};

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const asFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const CONFIRM = { scenario: "create", confirmStopsBeforeGrow: true };

function req(over: Partial<DiagRequest> & { body?: unknown } = {}): DiagRequest {
  const { body, ...rest } = over;
  return {
    hostname: STAGING_HOST,
    contentType: "application/json",
    rawBody: JSON.stringify(body ?? CONFIRM),
    env: stagingEnv,
    authorize: async () => "ok",
    fetchImpl: asFetch(async () => ok({ url: "https://pay.grow.example/secret-token-xyz", processToken: "tok-secret" })),
    ...rest,
  };
}

beforeEach(() => resetDiagnosticsCooldown());

test("זמינות: כבוי כברירת מחדל, ב-Production, ובלי שער Staging פעיל - הכול 404 לפני בדיקת הרשאה", async () => {
  let authCalled = false;
  const authorize = async () => {
    authCalled = true;
    return "ok" as const;
  };
  const cases: DiagEnv[] = [
    { ...stagingEnv, MAKE_DIAG_ENABLED: undefined },
    { ...stagingEnv, MAKE_DIAG_ENABLED: "false" },
    { ...stagingEnv, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" },
    { ...stagingEnv, STAGING_GATE_ENABLED: "false" },
    { ...stagingEnv, STAGING_GATE_PASSWORD: "short" },
  ];
  for (const env of cases) {
    assert.equal((await handleDiagnosticsPost(req({ env, authorize }))).status, 404);
    assert.equal((await handleDiagnosticsGet(STAGING_HOST, env, authorize)).status, 404);
  }
  assert.equal(authCalled, false);
  assert.equal(isDiagnosticsAvailable(STAGING_HOST, stagingEnv), true);
});

test("זיוף כותרת Host אינו מפעיל את הכלי ב-Production (הזהות נקבעת לפי RENDER_EXTERNAL_HOSTNAME)", () => {
  assert.equal(isDiagnosticsAvailable(STAGING_HOST, { ...stagingEnv, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }), false);
});

test("הרשאה: לא מחובר 401, משתמש רגיל 403, ובשני המקרים לא נשלחת בקשה ל-Make", async () => {
  let fetched = 0;
  const fetchImpl = asFetch(async () => {
    fetched++;
    return ok({});
  });
  assert.equal((await handleDiagnosticsPost(req({ authorize: async () => "unauthenticated", fetchImpl }))).status, 401);
  assert.equal((await handleDiagnosticsPost(req({ authorize: async () => "forbidden", fetchImpl }))).status, 403);
  assert.equal((await handleDiagnosticsGet(STAGING_HOST, stagingEnv, async () => "forbidden")).status, 403);
  assert.equal(fetched, 0);
});

test("לא proxy: כל שדה נוסף נדחה, והכתובת שנקראת היא רק זו מה-env", async () => {
  let fetched = 0;
  const fetchImpl = asFetch(async () => {
    fetched++;
    return ok({});
  });
  for (const extra of [{ url: "https://evil.example" }, { headers: { a: "b" } }, { body: {} }, { method: "GET" }, { webhookUrl: "https://evil.example" }]) {
    assert.equal((await handleDiagnosticsPost(req({ body: { ...CONFIRM, ...extra }, fetchImpl }))).status, 400);
  }
  for (const scenario of ["other", "", 1, null, "__proto__"]) {
    assert.equal((await handleDiagnosticsPost(req({ body: { scenario, confirmStopsBeforeGrow: true }, fetchImpl }))).status, 400);
  }
  assert.equal(fetched, 0);

  const urls: string[] = [];
  const spy = asFetch(async (u) => {
    urls.push(String(u));
    return ok({});
  });
  await handleDiagnosticsPost(req({ fetchImpl: spy }));
  resetDiagnosticsCooldown();
  await handleDiagnosticsPost(req({ body: { scenario: "verify", confirmStopsBeforeGrow: true }, fetchImpl: spy }));
  assert.deepEqual(urls, [CREATE_URL, VERIFY_URL]);
});

test("גוף לא תקין, סוג תוכן שגוי, וחוסר אישור עצירה לפני Grow נדחים", async () => {
  assert.equal((await handleDiagnosticsPost(req({ rawBody: "not json" }))).status, 400);
  assert.equal((await handleDiagnosticsPost(req({ rawBody: "[]" }))).status, 400);
  assert.equal((await handleDiagnosticsPost(req({ contentType: "text/plain" }))).status, 415);
  assert.equal((await handleDiagnosticsPost(req({ contentType: null }))).status, 415);
  assert.equal((await handleDiagnosticsPost(req({ body: { scenario: "create" } }))).status, 400);
  assert.equal((await handleDiagnosticsPost(req({ body: { scenario: "create", confirmStopsBeforeGrow: "true" } }))).status, 400);
});

test("תרחיש לא מוגדר -> 409; הצלחה לא חושפת כתובת, מפתח, קישור או טוקן", async () => {
  const noVerify = { ...stagingEnv, MAKE_VERIFY_WEBHOOK_URL: undefined };
  assert.equal((await handleDiagnosticsPost(req({ env: noVerify, body: { scenario: "verify", confirmStopsBeforeGrow: true } }))).status, 409);
  const r = await handleDiagnosticsPost(req());
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  for (const secret of [CREATE_URL, "create-secret-path", CREATE_KEY, "secret-token-xyz", "tok-secret", "pay.grow.example"]) {
    assert.ok(!text.includes(secret), secret);
  }
  const result = r.body.result as { outcome: string; responseFields: string[]; hasUrlField: boolean };
  assert.equal(result.outcome, "SUCCESS");
  assert.deepEqual(result.responseFields, ["url", "processToken"]);
  assert.equal(result.hasUrlField, true);
});

test("הבקשה ל-Make נושאת x-make-apikey של התרחיש הנכון ונתוני דמה עם סימון diagnostic", async () => {
  const seen: { headers: Record<string, string>; body: Record<string, string> }[] = [];
  const fetchImpl = asFetch(async (_u, init) => {
    seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return ok({});
  });
  await handleDiagnosticsPost(req({ fetchImpl }));
  resetDiagnosticsCooldown();
  await handleDiagnosticsPost(req({ body: { scenario: "verify", confirmStopsBeforeGrow: true }, fetchImpl }));
  assert.equal(seen[0].headers["x-make-apikey"], CREATE_KEY);
  assert.equal(seen[1].headers["x-make-apikey"], VERIFY_KEY);
  assert.equal(seen[0].body.diagnostic, "DISCOVER");
  assert.equal(seen[1].body.diagnostic, "DISCOVER");
  assert.equal(seen[0].body.fullName, "Test Customer");
  assert.match(seen[1].body.processToken, /^DUMMY/);
});

test("קטגוריות תוצאה: אימות, שגיאת Make, timeout, רשת ותשובה לא תקינה - בלי דליפת סודות", async () => {
  const run = async (fetchImpl: typeof fetch) => {
    resetDiagnosticsCooldown();
    const r = await handleDiagnosticsPost(req({ fetchImpl }));
    const text = JSON.stringify(r.body);
    for (const secret of [CREATE_URL, "create-secret-path", CREATE_KEY]) assert.ok(!text.includes(secret), secret);
    return r.body.result as { outcome: string; httpStatus?: number; hints?: string[] };
  };
  const auth = await run(asFetch(async () => new Response("Unauthorized", { status: 401 })));
  assert.equal(auth.outcome, "AUTH_FAILED");
  assert.equal(auth.httpStatus, 401);
  assert.ok(auth.hints!.some((h) => h.includes("x-make-apikey")));
  assert.equal((await run(asFetch(async () => new Response("x", { status: 500 })))).outcome, "MAKE_ERROR");
  assert.equal(
    (await run(asFetch(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }))).outcome,
    "TIMEOUT"
  );
  assert.equal((await run(asFetch(async () => { throw new Error(`down ${CREATE_URL}`); }))).outcome, "NETWORK_ERROR");
  assert.equal((await run(asFetch(async () => new Response("<html>", { status: 200 })))).outcome, "ACCEPTED_NO_RESPONSE");
  assert.equal((await run(asFetch(async () => new Response("[1]", { status: 200 })))).outcome, "BAD_RESPONSE");
});

test("רמזי כשל אימות מאבחנים רווח/מרכאות במפתח בלי לחשוף אותו", async () => {
  const env = { ...stagingEnv, MAKE_PAYMENT_API_KEY: ` "${CREATE_KEY}"\n` };
  const r = await handleDiagnosticsPost(req({ env, fetchImpl: asFetch(async () => new Response("", { status: 401 })) }));
  const hints = (r.body.result as { hints: string[] }).hints.join("|");
  assert.match(hints, /רווח/);
  assert.ok(!hints.includes(CREATE_KEY));
});

test("הגבלת קצב: בקשה שנייה לאותו תרחיש תוך שניות נדחית", async () => {
  assert.equal((await handleDiagnosticsPost(req({ now: () => 1000 }))).status, 200);
  assert.equal((await handleDiagnosticsPost(req({ now: () => 1500 }))).status, 429);
  assert.equal((await handleDiagnosticsPost(req({ now: () => 5000 }))).status, 200);
});

test("מבנה גוף היצירה זהה לשדות ש-MakeGrowPaymentProvider שולח בפועל", async () => {
  let sent: Record<string, string> = {};
  const provider = new MakeGrowPaymentProvider({
    webhookUrl: CREATE_URL,
    apiKey: CREATE_KEY,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    db: { user: { findUnique: async () => ({ name: "Test Customer", phone: "0500000000", email: "test@example.invalid" }) } } as unknown as PrismaClient,
    store: new InMemoryMockStore(),
    fetchImpl: asFetch(async (_u, init) => {
      sent = JSON.parse(String(init.body));
      return ok({ url: "https://pay.grow.example/x" });
    }),
  });
  await provider.createPaymentRequest({ amountAgorot: 30000, currency: "ILS", description: "d", idempotencyKey: "k", customerRef: "u", metadata: { packageHours: "5" }, returnUrl: "https://example.com/r" });
  const diagKeys = Object.keys(buildCreatePayload()).filter((k) => k !== "diagnostic");
  const providerKeys = Object.keys(sent).filter((k) => k !== "returnUrl");
  assert.deepEqual(diagKeys.sort(), providerKeys.sort());
});

test("ברירת המחדל של Make (200 'Accepted' בלי Webhook response) אינה כשל אימות או תקשורת", async () => {
  for (const make of [() => new Response("Accepted", { status: 200 }), () => new Response("", { status: 200 }), () => new Response("Accepted", { status: 202 })]) {
    resetDiagnosticsCooldown();
    const r = await handleDiagnosticsPost(req({ fetchImpl: asFetch(async () => make()) }));
    const result = r.body.result as { outcome: string; hints?: string[] };
    assert.equal(result.outcome, "ACCEPTED_NO_RESPONSE");
    assert.equal(result.hints, undefined);
  }
});

test("410 (אין תרחיש מאזין) מסווג NOT_LISTENING ולא כשל אימות; 401 ו-403 בלבד הם כשל אימות", async () => {
  const outcome = async (status: number) => {
    resetDiagnosticsCooldown();
    const r = await handleDiagnosticsPost(req({ fetchImpl: asFetch(async () => new Response("x", { status })) }));
    return (r.body.result as { outcome: string }).outcome;
  };
  assert.equal(await outcome(410), "NOT_LISTENING");
  assert.equal(await outcome(401), "AUTH_FAILED");
  assert.equal(await outcome(403), "AUTH_FAILED");
  assert.equal(await outcome(400), "MAKE_ERROR");
  assert.equal(await outcome(429), "MAKE_ERROR");
});

test("מסלול Webhook response מוקדם: תשובת ack בלי url היא SUCCESS בלי אזהרה; url בתשובה גורר אזהרה שייתכן ש-Grow הורץ", async () => {
  resetDiagnosticsCooldown();
  const ack = await handleDiagnosticsPost(req({ fetchImpl: asFetch(async () => ok({ diagnostic: "ack" })) }));
  const a = ack.body.result as { outcome: string; warnings?: string[]; hasUrlField: boolean };
  assert.equal(a.outcome, "SUCCESS");
  assert.equal(a.hasUrlField, false);
  assert.equal(a.warnings, undefined);
  resetDiagnosticsCooldown();
  const ran = await handleDiagnosticsPost(req());
  const w = (ran.body.result as { warnings?: string[] }).warnings;
  assert.ok(w && w[0].includes("Grow"));
});
