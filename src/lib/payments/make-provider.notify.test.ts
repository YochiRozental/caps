import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import {
  MAKE_NOTIFY_PATH,
  MakeGrowPaymentProvider,
  flattenGrowNotifyBody,
  signNotifyRef,
  verifyNotifySignature,
} from "@/lib/payments/make-provider";
import { WebhookVerificationError } from "@/lib/payments/provider";
import { SIGNED_NOTIFY_PATH, isExemptPath } from "@/lib/staging-gate/config";

/** התראת שרת מ-Grow (notifyUrl) לספק Make: HTTP מדומה, DB מדומה ואחסון בזיכרון. בלי רשת ובלי Make אמיתי */

const HOOK = "https://hook.eu1.make.com/create-abc";
const VERIFY_HOOK = "https://hook.eu1.make.com/verify-xyz";
const APPROVE_HOOK = "https://hook.eu1.make.com/approve-qqq";
const API_KEY = "k".repeat(32);
const BASE = "https://caps-staging-ppb1.onrender.com";
const db = { user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: "d@x.com" }) } } as unknown as PrismaClient;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const PKG_REQ = { amountAgorot: 50000, currency: "ILS" as const, description: "d", idempotencyKey: "package:u1:abcdefgh", customerRef: "u1", metadata: { packageHours: "5" } };

type Call = { url: string; body: Record<string, string> };

function setup(opts: { approve?: boolean; approveReply?: () => Response } = {}) {
  const calls: Call[] = [];
  const store = new InMemoryMockStore();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    if (String(url) === APPROVE_HOOK) return (opts.approveReply ?? (() => ok({ status: "1" })))();
    if (String(url) === VERIFY_HOOK) return ok({ reference: call.body.reference, processId: call.body.processId, statusCode: "2", sum: "500.00", transactionId: "TX9" });
    return ok({ url: "https://pay.grow.example/abc", processId: "777", processToken: "T1" });
  }) as unknown as typeof fetch;
  const p = new MakeGrowPaymentProvider({
    webhookUrl: HOOK,
    apiKey: API_KEY,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    verify: { webhookUrl: VERIFY_HOOK, apiKey: "v".repeat(32) },
    approve: opts.approve ? { webhookUrl: APPROVE_HOOK, apiKey: "a".repeat(32) } : undefined,
    returnBaseUrl: BASE + "/",
    db,
    store,
    fetchImpl,
    timeoutMs: 500,
  });
  return { p, calls, store };
}

function queryOf(notifyUrl: string): Record<string, string> {
  return Object.fromEntries(new URL(notifyUrl).searchParams);
}

test("יצירת תשלום שולחת ל-Make כתובת התראה חתומה של האתר, לנתיב הייעודי", async () => {
  const { p, calls } = setup();
  const r = await p.createPaymentRequest(PKG_REQ);
  const notifyUrl = calls[0].body.notifyUrl;
  const u = new URL(notifyUrl);
  assert.equal(u.origin + u.pathname, BASE + MAKE_NOTIFY_PATH);
  assert.equal(u.searchParams.get("ref"), r.providerPaymentId);
  assert.ok(verifyNotifySignature(r.providerPaymentId, u.searchParams.get("sig") ?? "", API_KEY));
  // הכתובת אינה חושפת את מפתח ה-API
  assert.ok(!notifyUrl.includes(API_KEY));
});

test("בלי בסיס HTTPS של האתר לא נשלחת כתובת התראה", async () => {
  const calls: Call[] = [];
  const p = new MakeGrowPaymentProvider({
    webhookUrl: HOOK,
    apiKey: API_KEY,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    db,
    store: new InMemoryMockStore(),
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return ok({ url: "https://pay.grow.example/abc", processId: "1", processToken: "t" });
    }) as unknown as typeof fetch,
  });
  await p.createPaymentRequest(PKG_REQ);
  assert.equal(calls[0].body.notifyUrl, undefined);
});

test("התראה עם חתימה תקינה הופכת לטריגר אימות לאותו תשלום; כל משלוח מקבל eventId חדש", async () => {
  const { p, calls } = setup();
  const r = await p.createPaymentRequest(PKG_REQ);
  const query = queryOf(calls[0].body.notifyUrl);
  const e1 = await p.parseWebhook({ rawBody: "", headers: {}, query });
  const e2 = await p.parseWebhook({ rawBody: "", headers: {}, query });
  assert.equal(e1.type, "payment.updated");
  assert.equal(e1.providerPaymentId, r.providerPaymentId);
  assert.notEqual(e1.eventId, e2.eventId);
  // ההתראה עצמה לא מאשרת דבר: הסטטוס נשלף מ-Grow דרך תרחיש האימות
  const verified = await p.getPaymentStatus(e1.providerPaymentId);
  assert.equal(verified.status, "SUCCEEDED");
  assert.equal(verified.amountAgorot, 50000);
});

test("התראה בלי חתימה, עם חתימה שגויה, לתשלום אחר או במפתח אחר - נדחית", async () => {
  const { p, calls } = setup();
  const r = await p.createPaymentRequest(PKG_REQ);
  const { sig } = queryOf(calls[0].body.notifyUrl);
  const other = "make:" + "0".repeat(32);
  const bad: (Record<string, string> | undefined)[] = [
    undefined,
    {},
    { ref: r.providerPaymentId },
    { ref: r.providerPaymentId, sig: "0".repeat(64) },
    { ref: r.providerPaymentId, sig: sig.slice(0, 63) },
    { ref: other, sig },
    { ref: other, sig: signNotifyRef(other, API_KEY) }, // חתום, אבל לא קיים בשרת
    { ref: r.providerPaymentId, sig: signNotifyRef(r.providerPaymentId, "x".repeat(32)) },
    { ref: "../../admin", sig },
  ];
  for (const query of bad) {
    await assert.rejects(p.parseWebhook({ rawBody: "", headers: {}, query }), WebhookVerificationError, JSON.stringify(query));
  }
});

test("גוף התראה שמצביע על רכישה אחרת (cField1) נדחה גם כשהחתימה תקינה", async () => {
  const { p, calls } = setup();
  await p.createPaymentRequest(PKG_REQ);
  const query = queryOf(calls[0].body.notifyUrl);
  await assert.rejects(p.parseWebhook({ rawBody: "data[customFields][cField1]=make:" + "1".repeat(32), headers: {}, query }), WebhookVerificationError);
  // התאמה מלאה מתקבלת
  const ev = await p.parseWebhook({ rawBody: `data[processId]=777&data[customFields][cField1]=${query.ref}`, headers: {}, query });
  assert.equal(ev.providerPaymentId, query.ref);
});

test("processId שונה בגוף ההתראה (כפי שנמצא ב-Staging) אינו חוסם: ההתראה מובילה לאימות לפי המזהים השמורים בשרת", async () => {
  const { p, calls } = setup();
  const r = await p.createPaymentRequest(PKG_REQ);
  const query = queryOf(calls[0].body.notifyUrl);
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (msg: string) => void logged.push(msg);
  try {
    const ev = await p.parseWebhook({ rawBody: JSON.stringify({ data: { processId: "999", transactionId: "TX9" } }), headers: {}, query });
    assert.equal(ev.providerPaymentId, r.providerPaymentId);
  } finally {
    console.warn = warn;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /stored=777 notify=999/);
  assert.ok(!logged[0].includes("T1"), "הטוקן השמור לא נרשם בלוג");
  // האימות שאחרי ההתראה פונה לתרחיש האימות עם המזהים השמורים (777), לא עם מה שהגיע בגוף ההתראה
  const v = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(v.status, "SUCCEEDED");
  const verifyCall = calls.find((c) => c.url === VERIFY_HOOK);
  assert.equal(verifyCall?.body.processId, "777");
  assert.equal(verifyCall?.body.processToken, "T1");
});

test("התראה עם עסקה שכבר שויכה לרכישה אחרת נדחית", async () => {
  // רכישה ראשונה מאומתת ומשייכת את עסקה TX9 לעצמה
  const first = setup();
  const r1 = await first.p.createPaymentRequest(PKG_REQ);
  assert.equal((await first.p.getPaymentStatus(r1.providerPaymentId)).status, "SUCCEEDED");
  // רכישה שנייה באותו אחסון מקבלת התראה שמצביעה על אותה עסקה
  const sent: { body: Record<string, string> }[] = [];
  const secondWithCapture = new MakeGrowPaymentProvider({
    webhookUrl: HOOK,
    apiKey: API_KEY,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    returnBaseUrl: BASE,
    db,
    store: first.store,
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body)) });
      return ok({ url: "https://pay.grow.example/xyz", processId: "888", processToken: "T2" });
    }) as unknown as typeof fetch,
  });
  await secondWithCapture.createPaymentRequest({ ...PKG_REQ, idempotencyKey: "package:u1:second00" });
  const q2 = queryOf(sent[0].body.notifyUrl);
  await assert.rejects(secondWithCapture.parseWebhook({ rawBody: "data[transactionId]=TX9", headers: {}, query: q2 }), WebhookVerificationError);
  // עסקה חדשה (שלא שויכה) מתקבלת כטריגר רגיל
  const ok2 = await secondWithCapture.parseWebhook({ rawBody: "data[transactionId]=TX10", headers: {}, query: q2 });
  assert.equal(ok2.providerPaymentId, q2.ref);
});

test("פענוח גוף ההתראה: JSON, טופס שטוח וטופס בסגנון data[...]", () => {
  assert.deepEqual(flattenGrowNotifyBody(JSON.stringify({ status: 1, data: { transactionId: 5, processId: "7", customFields: { cField1: "r" } } })), {
    transactionId: "5",
    processId: "7",
    cField1: "r",
  });
  assert.deepEqual(flattenGrowNotifyBody("transactionId=5&statusCode=2"), { transactionId: "5", statusCode: "2" });
  assert.deepEqual(flattenGrowNotifyBody("data[transactionId]=5&data[customFields][cField1]=r&err="), { transactionId: "5", cField1: "r", err: "" });
  assert.deepEqual(flattenGrowNotifyBody("{not json"), {});
  assert.deepEqual(flattenGrowNotifyBody(""), {});
});

test("approveTransaction דרך Make: נשלח פעם אחת עם נתוני ההתראה, וכשל בו לא חוסם", async () => {
  const { p, calls } = setup({ approve: true });
  await p.createPaymentRequest(PKG_REQ);
  const query = queryOf(calls[0].body.notifyUrl);
  const body = `data[transactionId]=TX9&data[processId]=777&data[sum]=500&data[asmachta]=123&data[customFields][cField1]=${query.ref}`;
  await p.parseWebhook({ rawBody: body, headers: {}, query });
  await p.parseWebhook({ rawBody: body, headers: {}, query });
  const approves = calls.filter((c) => c.url === APPROVE_HOOK);
  assert.equal(approves.length, 1, "אישור שהצליח לא נשלח שוב בהתראה חוזרת");
  assert.equal(approves[0].body.transactionId, "TX9");
  assert.equal(approves[0].body.asmachta, "123");
  assert.equal(approves[0].body.reference, query.ref);

  const failing = setup({ approve: true, approveReply: () => new Response("x", { status: 500 }) });
  await failing.p.createPaymentRequest(PKG_REQ);
  const q2 = queryOf(failing.calls[0].body.notifyUrl);
  const ev = await failing.p.parseWebhook({ rawBody: "data[transactionId]=TX9", headers: {}, query: q2 });
  assert.equal(ev.providerPaymentId, q2.ref);
  await failing.p.parseWebhook({ rawBody: "data[transactionId]=TX9", headers: {}, query: q2 });
  assert.equal(failing.calls.filter((c) => c.url === APPROVE_HOOK).length, 2, "אישור שנכשל ינוסה שוב בהתראה הבאה");
});

test("בלי תרחיש אישור או בלי transactionId - אין פנייה לאישור", async () => {
  const { p, calls } = setup();
  await p.createPaymentRequest(PKG_REQ);
  await p.parseWebhook({ rawBody: "data[transactionId]=TX9", headers: {}, query: queryOf(calls[0].body.notifyUrl) });
  const withApprove = setup({ approve: true });
  await withApprove.p.createPaymentRequest(PKG_REQ);
  await withApprove.p.parseWebhook({ rawBody: "", headers: {}, query: queryOf(withApprove.calls[0].body.notifyUrl) });
  assert.equal(calls.filter((c) => c.url === APPROVE_HOOK).length + withApprove.calls.filter((c) => c.url === APPROVE_HOOK).length, 0);
});

test("שער ה-Staging פוטר רק את נתיב ההתראה החתומה, בהתאמה מדויקת", () => {
  assert.equal(SIGNED_NOTIFY_PATH, MAKE_NOTIFY_PATH);
  assert.equal(isExemptPath(MAKE_NOTIFY_PATH), true);
  for (const path of ["/api/payments/webhook/grow", "/api/payments/webhook/make-grow/x", "/api/payments/webhook/make-grow2", "/api/payments/webhook", "/api/payments/packages/purchase"]) {
    assert.equal(isExemptPath(path), false, path);
  }
});
