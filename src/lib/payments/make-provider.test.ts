import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore, type MockStore } from "@/lib/payments/mock-store";
import { getPaymentProvider } from "@/lib/payments/config";
import {
  MAKE_API_KEY_HEADER,
  MAKE_PROVIDER_VERIFICATION_READY,
  MakeGrowPaymentProvider,
  deriveMakePaymentId,
  parseCheckoutUrl,
} from "@/lib/payments/make-provider";
import { PaymentConfigError, PaymentError, WebhookVerificationError, type PaymentProvider } from "@/lib/payments/provider";

/** HTTP מדומה (fetchImpl מוזרק), DB מדומה ואחסון בזיכרון: בלי רשת, בלי מסד ובלי Make אמיתי */

const API_KEY = "k".repeat(32);
const HOOK = "https://hook.eu1.make.com/abc123secret";
const USERS: Record<string, { name: string; phone: string | null; email?: string | null }> = {
  u1: { name: "דנה כהן", phone: "0501234567", email: "d@x.com" },
  nophone: { name: "דנה כהן", phone: null },
};
const db = {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
} as unknown as PrismaClient;

type Call = { url: string; headers: Record<string, string>; body: Record<string, string> };

function provider(handler: (call: Call) => Response | Promise<Response>, store: MockStore = new InMemoryMockStore()) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, store, p: new MakeGrowPaymentProvider({ webhookUrl: HOOK, apiKey: API_KEY, environment: "sandbox", allowedCheckoutHosts: ["grow.example"], db, store, fetchImpl, timeoutMs: 500 }) as PaymentProvider };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const REQ = { amountAgorot: 30000, currency: "ILS" as const, description: "חבילת 5 שעות", idempotencyKey: "pkg:1", customerRef: "u1", metadata: { packageHours: "5" } };

test("יוצר קישור: שולח מפתח בכותרת, סכום משרת, ומחזיר PENDING עם קישור HTTPS", async () => {
  const { p, calls } = provider(() => ok({ url: "https://pay.grow.example/abc", processId: "123", processToken: "tok-secret" }));
  const r = await p.createPaymentRequest(REQ);
  assert.equal(r.status, "PENDING");
  assert.equal(r.checkoutUrl, "https://pay.grow.example/abc");
  assert.equal(r.providerPaymentId, deriveMakePaymentId("pkg:1"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK);
  assert.equal(calls[0].headers[MAKE_API_KEY_HEADER], API_KEY);
  assert.equal(calls[0].body.amount, "300.00");
  assert.equal(calls[0].body.purpose, "PACKAGE");
  assert.equal(calls[0].body.fullName, "דנה כהן");
});

test("טוקנים ומזהי Grow נשמרים בשרת בלבד ולא מופיעים בתוצאה שחוזרת", async () => {
  const { p, store } = provider(() => ok({ url: "https://pay.grow.example/abc", processId: "123", processToken: "tok-secret" }));
  const r = await p.createPaymentRequest(REQ);
  assert.ok(!JSON.stringify(r).includes("tok-secret"));
  const rec = await store.get<{ processToken?: string }>(`make-payment:${r.providerPaymentId}`);
  assert.equal(rec?.processToken, "tok-secret");
});

test("idempotency: אותה בקשה חוזרת מחזירה אותו קישור ולא פונה ל-Make שוב", async () => {
  const { p, calls } = provider(() => ok({ url: "https://pay.grow.example/abc" }));
  const a = await p.createPaymentRequest(REQ);
  const b = await p.createPaymentRequest(REQ);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
});

test("idempotency: בקשות מקבילות באותו מפתח יוצרות קישור אחד בלבד", async () => {
  const { p, calls } = provider(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return ok({ url: "https://pay.grow.example/abc" });
  });
  const [a, b] = await Promise.all([p.createPaymentRequest(REQ), p.createPaymentRequest(REQ)]);
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  assert.equal(calls.length, 1);
});

test("idempotency: אותו מפתח עם סכום שונה נדחה", async () => {
  const { p } = provider(() => ok({ url: "https://pay.grow.example/abc" }));
  await p.createPaymentRequest(REQ);
  await assert.rejects(p.createPaymentRequest({ ...REQ, amountAgorot: 100 }), /כבר שימש/);
});

test("timeout: ניסיון חוזר באותו מפתח לא יוצר קישור כפול ודורש בירור", async () => {
  const { p, calls } = provider(() => {
    throw new Error("network down https://hook.eu1.make.com/abc123secret");
  });
  await assert.rejects(p.createPaymentRequest(REQ), (e: Error) => e instanceof PaymentError && !e.message.includes("abc123secret"));
  await assert.rejects(p.createPaymentRequest(REQ), /לא ידוע/);
  assert.equal(calls.length, 1);
});

test("תשובת 4xx/5xx מ-Make אינה הוכחה שלא נוצר קישור: ניסיון חוזר באותו מפתח נחסם ולא פונה שוב", async () => {
  for (const status of [400, 401, 403, 500]) {
    const { p, calls } = provider(() => new Response("no", { status }));
    await assert.rejects(p.createPaymentRequest(REQ), PaymentError);
    await assert.rejects(p.createPaymentRequest(REQ), /לא ידוע/);
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("שגיאת תשלום-חלקית: קישור תקין נשמר אך עדכון התפיסה נכשל -> ניסיון חוזר מחזיר אותו קישור בלי קריאה שנייה", async () => {
  const inner = new InMemoryMockStore();
  const flaky: MockStore = {
    get: (k) => inner.get(k),
    putIfAbsent: (k, v) => inner.putIfAbsent(k, v),
    put: async (k, v) => {
      if (k.startsWith("make-create:") && (v as { state: string }).state === "done") throw new Error("db down");
      return inner.put(k, v);
    },
  };
  const { p, calls } = provider(() => ok({ url: "https://pay.grow.example/abc" }), flaky);
  await assert.rejects(p.createPaymentRequest(REQ), /db down/);
  const again = await p.createPaymentRequest(REQ);
  assert.equal(again.checkoutUrl, "https://pay.grow.example/abc");
  assert.equal(again.providerPaymentId, deriveMakePaymentId("pkg:1"));
  assert.equal(calls.length, 1);
});

test("כשל לפני השליחה (לקוח בלי טלפון) לא משאיר תפיסה, ולא נשלח דבר ל-Make", async () => {
  const { p, calls, store } = provider(() => ok({ url: "https://pay.grow.example/abc" }));
  await assert.rejects(p.createPaymentRequest({ ...REQ, customerRef: "nophone", idempotencyKey: "pre" }), PaymentError);
  assert.equal(await store.get("make-create:pre"), undefined);
  assert.equal(calls.length, 0);
});

test("מפתחות האחסון של Make נפרדים מאלה של Grow", async () => {
  const { p, store } = provider(() => ok({ url: "https://pay.grow.example/abc" }));
  await p.createPaymentRequest(REQ);
  assert.ok(await store.get("make-create:pkg:1"));
  assert.equal(await store.get("grow-create:pkg:1"), undefined);
});

test("תשובה בלי קישור / עם קישור לא תקין נכשלת", async () => {
  for (const body of [{}, { url: "http://pay.example/x" }, { url: "https://localhost/x" }, { url: "https://u:p@pay.example/x" }, { url: "https://10.0.0.1/x" }, { url: "javascript:alert(1)" }, { url: "https://evil.example/x" }, { url: "https://notgrow.example/x" }]) {
    const { p } = provider(() => ok(body));
    await assert.rejects(p.createPaymentRequest({ ...REQ, idempotencyKey: `k-${JSON.stringify(body)}` }), PaymentError);
  }
  assert.throws(() => parseCheckoutUrl(undefined, ["grow.example"]), PaymentError);
  assert.equal(parseCheckoutUrl("https://pay.grow.example/x", ["grow.example"]), "https://pay.grow.example/x");
});

test("תשובה שאינה JSON נכשלת", async () => {
  const { p } = provider(() => new Response("<html>", { status: 200 }));
  await assert.rejects(p.createPaymentRequest(REQ), /JSON/);
});

test("סכום לא תקין, מטבע זר, שמירת כרטיס ולקוח בלי טלפון נכשלים לפני כל קריאה ל-Make", async () => {
  const { p, calls } = provider(() => ok({ url: "https://pay.grow.example/abc" }));
  await assert.rejects(p.createPaymentRequest({ ...REQ, amountAgorot: 0, idempotencyKey: "a" }), PaymentError);
  await assert.rejects(p.createPaymentRequest({ ...REQ, amountAgorot: 10.5, idempotencyKey: "b" }), PaymentError);
  await assert.rejects(p.createPaymentRequest({ ...REQ, currency: "USD" as "ILS", idempotencyKey: "c" }), PaymentError);
  await assert.rejects(p.createPaymentRequest({ ...REQ, savePaymentMethod: true, idempotencyKey: "d" }), /שמירת אמצעי תשלום/);
  await assert.rejects(p.createPaymentRequest({ ...REQ, customerRef: "nophone", idempotencyKey: "e" }), PaymentError);
  assert.equal(calls.length, 0);
});

test("getPaymentStatus לעולם לא מחזיר סטטוס (בפרט לא SUCCEEDED) בלי אימות", async () => {
  const { p } = provider(() => ok({ url: "https://pay.grow.example/abc", status: "SUCCEEDED", paid: true }));
  const r = await p.createPaymentRequest(REQ);
  assert.equal(r.status, "PENDING");
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינו מוגדר/);
});

test("פעולות שלא נתמכות נכשלות במפורש בלי פנייה לרשת", async () => {
  const { p, calls } = provider(() => ok({}));
  await assert.rejects(p.refund({ providerPaymentId: "x", idempotencyKey: "r" }), PaymentError);
  await assert.rejects(p.chargeSavedMethod({ token: "t", amountAgorot: 100, currency: "ILS", description: "d", idempotencyKey: "c", customerRef: "u1" }), PaymentError);
  await assert.rejects(p.cancelPayment("x"), PaymentError);
  await assert.rejects(p.parseWebhook({ rawBody: "{}", headers: {} }), WebhookVerificationError);
  assert.equal(calls.length, 0);
});

test("בנאי: חוסם live, HTTP ומפתח קצר", () => {
  const base = { webhookUrl: HOOK, apiKey: API_KEY, environment: "sandbox" as const, allowedCheckoutHosts: ["grow.example"], db };
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, environment: "live" }), PaymentError);
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, webhookUrl: "http://hook.make.com/x" }), PaymentError);
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, apiKey: "short" }), PaymentError);
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, allowedCheckoutHosts: [] }), PaymentError);
  for (const bad of ["https://grow.example", "*.grow.example", "grow.example/x", "localhost", "GROW.example"]) {
    assert.throws(() => new MakeGrowPaymentProvider({ ...base, allowedCheckoutHosts: [bad] }), PaymentError, bad);
  }
});

test("PAYMENT_PROVIDER=make חסום גם עם תצורה מלאה, ואינו חושף ערכים; none/ללא ברירת מחדל נשארים חסומים", () => {
  assert.equal(MAKE_PROVIDER_VERIFICATION_READY, false);
  const full = { PAYMENT_PROVIDER: "make", PAYMENT_ENVIRONMENT: "sandbox", MAKE_PAYMENT_WEBHOOK_URL: HOOK, MAKE_PAYMENT_API_KEY: API_KEY, MAKE_PAYMENT_CHECKOUT_HOSTS: "pay.grow.example" };
  assert.throws(() => getPaymentProvider(full), (e: Error) => e instanceof PaymentConfigError && /חסום/.test(e.message) && !e.message.includes("abc123secret") && !e.message.includes(API_KEY));
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "make" }), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ ...full, MAKE_PAYMENT_CHECKOUT_HOSTS: "" }), /MAKE_PAYMENT_CHECKOUT_HOSTS/);
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "none" }), PaymentConfigError);
  assert.throws(() => getPaymentProvider({}), PaymentConfigError);
});
