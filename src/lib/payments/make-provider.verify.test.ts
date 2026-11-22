import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import { getPaymentProvider } from "@/lib/payments/config";
import { MakeGrowPaymentProvider } from "@/lib/payments/make-provider";
import { PaymentConfigError, PaymentError, type PaymentProvider } from "@/lib/payments/provider";

/** אימות תשלום דרך תרחיש Verify של Make, מקצה לקצה ברמת הספק: HTTP מדומה, DB מדומה ואחסון בזיכרון */

const HOOK = "https://hook.eu1.make.com/create-abc";
const VERIFY_HOOK = "https://hook.eu1.make.com/verify-xyz";
const API_KEY = "k".repeat(32);
const VERIFY_KEY = "v".repeat(32);
const BASE = "https://caps-staging-ppb1.onrender.com";

const db = {
  user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: "d@x.com" }) },
} as unknown as PrismaClient;

type Call = { url: string; headers: Record<string, string>; body: Record<string, string> };
type VerifyHandler = (call: Call) => Response | Promise<Response>;

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const CREATE_OK = { url: "https://pay.grow.example/abc", processId: "P1", processToken: "T1" };
const BOOKING_REQ = {
  amountAgorot: 30000,
  currency: "ILS" as const,
  description: "d",
  idempotencyKey: "booking:abc12345:1",
  customerRef: "u1",
  metadata: { appointmentId: "abc12345" },
};

function setup(createBody: unknown = CREATE_OK) {
  const calls: Call[] = [];
  const state: { verify: VerifyHandler } = { verify: (c) => ok({ reference: c.body.reference, processId: c.body.processId, statusCode: "0" }) };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return String(url) === VERIFY_HOOK ? state.verify(call) : ok(createBody);
  }) as unknown as typeof fetch;
  const p = new MakeGrowPaymentProvider({
    webhookUrl: HOOK,
    apiKey: API_KEY,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    verify: { webhookUrl: VERIFY_HOOK, apiKey: VERIFY_KEY },
    returnBaseUrl: BASE + "/",
    db,
    store: new InMemoryMockStore(),
    fetchImpl,
    timeoutMs: 500,
  }) as PaymentProvider;
  return { p, calls, state };
}

const paid =
  (over: Record<string, unknown> = {}, ref?: string): VerifyHandler =>
  (call) =>
    ok({ reference: ref ?? call.body.reference, processId: call.body.processId, statusCode: "2", sum: "300.00", transactionId: "TX1", ...over });

test("כתובת החזרה נבנית מבסיס האתר ומזהה ההזמנה בלבד (לא מקלט לקוח)", async () => {
  const { p, calls } = setup();
  await p.createPaymentRequest({ ...BOOKING_REQ, returnUrl: "https://evil.example/x" });
  assert.equal(calls[0].body.returnUrl, BASE + "/booking/checkout/abc12345");
  const pkg = setup();
  await pkg.p.createPaymentRequest({ ...BOOKING_REQ, idempotencyKey: "pkg:z", metadata: { packageHours: "5" } });
  assert.equal(pkg.calls[0].body.returnUrl, BASE + "/profile/hours");
});

test("ממתין (קוד 0 / חסר / לא מוכר) נשאר PENDING עם הסכום שביקשנו, ולעולם לא SUCCEEDED", async () => {
  const { p, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  for (const extra of [{ statusCode: "0" }, {}, { statusCode: "7" }, { statusCode: "" }, { statusCode: null }, { statusCode: "22" }]) {
    state.verify = (call) => ok({ reference: call.body.reference, processId: call.body.processId, ...extra });
    const s = await p.getPaymentStatus(r.providerPaymentId);
    assert.equal(s.status, "PENDING", JSON.stringify(extra));
    assert.equal(s.amountAgorot, 30000);
  }
});

test("שולם דורש קוד 2 + סכום + מזהה עסקה; הסכום המדווח הוא שחוזר (לזיהוי אי-התאמה)", async () => {
  const { p, calls, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  state.verify = paid();
  const s = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(s.status, "SUCCEEDED");
  assert.equal(s.amountAgorot, 30000);
  assert.equal(s.providerPaymentId, r.providerPaymentId);
  const verifyCall = calls.find((c) => c.url === VERIFY_HOOK)!;
  assert.equal(verifyCall.headers["x-make-apikey"], VERIFY_KEY);
  assert.equal(verifyCall.body.processId, "P1");
  assert.equal(verifyCall.body.processToken, "T1");
  // סכום שונה מהמבוקש: מוחזר כפי שדווח (booking-payment יסמן AMOUNT_MISMATCH ולא יאשר)
  state.verify = paid({ sum: "250.00" });
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).amountAgorot, 25000);
  for (const bad of [{ sum: undefined }, { sum: "0" }, { sum: "abc" }, { transactionId: undefined }, { transactionId: "" }]) {
    state.verify = paid(bad);
    await assert.rejects(p.getPaymentStatus(r.providerPaymentId), PaymentError, JSON.stringify(bad));
  }
  state.verify = paid({ statusCode: 2 });
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).status, "SUCCEEDED");
});

test("נדחה (9) ובוטל (4) ממופים, והטוקן לא דולף", async () => {
  const { p, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  state.verify = paid({ statusCode: "9" });
  const f = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(f.status, "FAILED");
  assert.equal(f.amountAgorot, 30000);
  state.verify = paid({ statusCode: "4" });
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).status, "CANCELLED");
  assert.ok(!JSON.stringify(f).includes("T1"));
});

test("reference שאינו תואם, מטבע זר, כשל Make, תשובת Accepted, timeout ומזהים חסרים - שגיאה ולא סטטוס", async () => {
  const { p, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  state.verify = paid({}, "make:" + "0".repeat(32));
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינה תואמת/);
  state.verify = paid({ currency: "USD" });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /ILS/);
  state.verify = () => new Response("no", { status: 401 });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), PaymentError);
  state.verify = () => new Response("Accepted", { status: 200 });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), PaymentError);
  state.verify = () => {
    throw new Error("down");
  };
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), PaymentError);
  await assert.rejects(p.getPaymentStatus("make:not-hex"), /לא תקין/);
  await assert.rejects(p.getPaymentStatus("make:" + "f".repeat(32)), /חסרים/);

  // Make לא החזיר processId/processToken ביצירה: לא ניתן לאמת (ולא מנחשים)
  const noIds = setup({ url: "https://pay.grow.example/abc" });
  const r2 = await noIds.p.createPaymentRequest(BOOKING_REQ);
  noIds.state.verify = paid();
  await assert.rejects(noIds.p.getPaymentStatus(r2.providerPaymentId), /חסרים/);
});

test("ביטול: מותר רק כשלא שולם; שולם או כשל אימות = שגיאה", async () => {
  const { p, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  await p.cancelPayment(r.providerPaymentId);
  state.verify = paid();
  await assert.rejects(p.cancelPayment(r.providerPaymentId), /הושלם/);
  state.verify = () => new Response("x", { status: 500 });
  await assert.rejects(p.cancelPayment(r.providerPaymentId), PaymentError);
});

test("תשלום מאוחר: אחרי ביטול מקומי, אימות שמגלה שולם מחזיר SUCCEEDED כדי שהזרימה תטפל בהחזר", async () => {
  const { p, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  await p.cancelPayment(r.providerPaymentId);
  state.verify = paid();
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).status, "SUCCEEDED");
});

test("כפילות אחרי timeout ביצירה: אין קישור שני", async () => {
  let failCreate = true;
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    if (failCreate) throw new Error("timeout");
    return ok(CREATE_OK);
  }) as unknown as typeof fetch;
  const p = new MakeGrowPaymentProvider({
    webhookUrl: HOOK,
    apiKey: API_KEY,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    db,
    store: new InMemoryMockStore(),
    fetchImpl,
  }) as PaymentProvider;
  await assert.rejects(p.createPaymentRequest(BOOKING_REQ), PaymentError);
  failCreate = false;
  await assert.rejects(p.createPaymentRequest(BOOKING_REQ), /לא ידוע/);
  assert.equal(calls.length, 1);
});

test("PAYMENT_PROVIDER=make: גם עם כל המשתנים ושער Staging פעיל - חסום כל עוד האימות לא סומן מוכן; מחוץ ל-Staging נוספת חסימה", () => {
  const staging = {
    PAYMENT_PROVIDER: "make",
    PAYMENT_ENVIRONMENT: "sandbox",
    MAKE_PAYMENT_WEBHOOK_URL: HOOK,
    MAKE_PAYMENT_API_KEY: API_KEY,
    MAKE_PAYMENT_CHECKOUT_HOSTS: "sandbox.grow.link",
    MAKE_VERIFY_WEBHOOK_URL: VERIFY_HOOK,
    MAKE_VERIFY_API_KEY: VERIFY_KEY,
    MAKE_PAYMENT_RETURN_BASE_URL: BASE,
    STAGING_GATE_ENABLED: "true",
    STAGING_GATE_PASSWORD: "p".repeat(16),
    RENDER_EXTERNAL_HOSTNAME: "caps-staging-ppb1.onrender.com",
  };
  assert.throws(() => getPaymentProvider(staging), (e: Error) => e instanceof PaymentConfigError && /VERIFICATION_READY/.test(e.message) && !/Staging עם שער/.test(e.message));
  const confirmed = { ...staging, MAKE_VERIFICATION_CONFIRMED: "true" };
  assert.equal(getPaymentProvider(confirmed).name, "make-grow");
  assert.throws(() => getPaymentProvider({ ...confirmed, MAKE_VERIFICATION_CONFIRMED: "1" }), /VERIFICATION_READY/);
  assert.throws(() => getPaymentProvider({ ...confirmed, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }), /Staging עם שער/);
  assert.throws(() => getPaymentProvider({ ...confirmed, STAGING_GATE_ENABLED: "false" }), /Staging עם שער/);
  assert.throws(() => getPaymentProvider({ ...confirmed, PAYMENT_ENVIRONMENT: "live" }), /sandbox/);
  assert.throws(() => getPaymentProvider({ ...staging, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }), (e: Error) => /Staging עם שער/.test(e.message));
  assert.throws(() => getPaymentProvider({ ...staging, MAKE_VERIFY_API_KEY: "" }), /MAKE_VERIFY_API_KEY/);
  assert.throws(() => getPaymentProvider({ ...staging, MAKE_PAYMENT_RETURN_BASE_URL: "http://x.com" }), /MAKE_PAYMENT_RETURN_BASE_URL/);
});

test("זיהוי מדויק: processId חסר/שונה בתשובה נדחה, ועסקה אחת לא מאשרת שני תשלומים", async () => {
  const { p, state } = setup();
  const r = await p.createPaymentRequest(BOOKING_REQ);
  state.verify = paid({ processId: undefined });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינה מזהה/);
  state.verify = paid({ processId: "OTHER" });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינה מזהה/);
  state.verify = paid({ processId: 1 });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינה מזהה/);

  state.verify = paid();
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).status, "SUCCEEDED");
  // אימות חוזר של אותו תשלום עם אותה עסקה תקין (אידמפוטנטי)
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).status, "SUCCEEDED");
});

test("אותה עסקה (transactionId) שמוחזרת לתשלום אחר נדחית", async () => {
  const shared = new InMemoryMockStore();
  const mk = () =>
    new MakeGrowPaymentProvider({
      webhookUrl: HOOK,
      apiKey: API_KEY,
      environment: "sandbox",
      allowedCheckoutHosts: ["grow.example"],
      verify: { webhookUrl: VERIFY_HOOK, apiKey: VERIFY_KEY },
      db,
      store: shared,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (String(url) === VERIFY_HOOK) return paid()({ url: String(url), headers: {}, body });
        return ok(CREATE_OK);
      }) as unknown as typeof fetch,
    }) as PaymentProvider;
  const p = mk();
  const a = await p.createPaymentRequest(BOOKING_REQ);
  const b = await p.createPaymentRequest({ ...BOOKING_REQ, idempotencyKey: "booking:zzz99999:1", metadata: { appointmentId: "zzz99999" } });
  assert.equal((await p.getPaymentStatus(a.providerPaymentId)).status, "SUCCEEDED");
  await assert.rejects(p.getPaymentStatus(b.providerPaymentId), /שויך לתשלום אחר/);
});

test("getRealProviderConfigProblem: make/grow שבורים מדווחים בעיה (שמות משתנים בלבד); none/mock/ריק - null", async () => {
  const { getRealProviderConfigProblem } = await import("@/lib/payments/config");
  const p = getRealProviderConfigProblem({ PAYMENT_PROVIDER: "make", PAYMENT_ENVIRONMENT: "sandbox", MAKE_PAYMENT_API_KEY: "secret-value-that-is-long-enough-1234" });
  assert.ok(p && /MAKE_PAYMENT_WEBHOOK_URL/.test(p));
  assert.ok(!p.includes("secret-value"));
  assert.ok(getRealProviderConfigProblem({ PAYMENT_PROVIDER: "grow" }));
  assert.equal(getRealProviderConfigProblem({ PAYMENT_PROVIDER: "none" }), null);
  assert.equal(getRealProviderConfigProblem({ PAYMENT_PROVIDER: "mock" }), null);
  assert.equal(getRealProviderConfigProblem({}), null);
});
