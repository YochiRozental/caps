import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import { MakeGrowPaymentProvider } from "@/lib/payments/make-provider";
import { handleDryRunGet, handleDryRunPost, resetDryRunCooldown, type DryRunEnv, type DryRunPayment, type DryRunRequest } from "@/lib/payments/verify-dry-run";

/** בדיקה יבשה של Verify v2: זמינות, הרשאה, קריאה בלבד, ניתוב לתרחיש v2 בלבד, וההחלטה המוצגת */

const STAGING_HOST = "caps-staging-ppb1.onrender.com";
const CREATE_URL = "https://hook.eu1.make.com/create-path";
const VERIFY_URL = "https://hook.eu1.make.com/verify-old-path";
const V2_URL = "https://hook.eu1.make.com/verify-v2-path";
const V2_KEY = "v2-key-" + "c".repeat(24);
const LINK = "82439";

const env: DryRunEnv = {
  MAKE_DIAG_ENABLED: "true",
  STAGING_GATE_ENABLED: "true",
  STAGING_GATE_PASSWORD: "x".repeat(16),
  RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
  MAKE_PAYMENT_WEBHOOK_URL: CREATE_URL,
  MAKE_PAYMENT_API_KEY: "create-" + "a".repeat(24),
  MAKE_VERIFY_WEBHOOK_URL: VERIFY_URL,
  MAKE_VERIFY_API_KEY: "verify-" + "b".repeat(24),
  MAKE_VERIFY_V2_WEBHOOK_URL: V2_URL,
  MAKE_VERIFY_V2_API_KEY: V2_KEY,
};

const db = { user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: "d@x.com" }) } } as unknown as PrismaClient;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
type Call = { url: string; key: string; body: Record<string, string> };
const paidTx = (transactionId: string, sum = "300") => ({ statusCode: "2", sum, transactionId, paymentLinkProcessId: LINK });

async function setup(transactions: unknown, raw?: (b: Record<string, string>) => Response) {
  const calls: Call[] = [];
  const store = new InMemoryMockStore();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    calls.push({ url: String(url), key: (init?.headers as Record<string, string>)["x-make-apikey"], body });
    if (String(url) === CREATE_URL) return ok({ url: "https://pay.grow.example/x", processId: LINK, processToken: "SECRET-PROCESS-TOKEN" });
    if (raw) return raw(body);
    return ok({ format: "v2", reference: body.reference, processId: body.processId, grow: { transactions } });
  }) as unknown as typeof fetch;
  const provider = new MakeGrowPaymentProvider({
    webhookUrl: CREATE_URL,
    apiKey: env.MAKE_PAYMENT_API_KEY!,
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    verify: { webhookUrl: VERIFY_URL, apiKey: env.MAKE_VERIFY_API_KEY! },
    returnBaseUrl: "https://" + STAGING_HOST,
    db,
    store,
    fetchImpl,
    timeoutMs: 500,
  });
  const created = await provider.createPaymentRequest({
    amountAgorot: 30000,
    currency: "ILS",
    description: "חבילת 5 שעות",
    idempotencyKey: "package:u1:dryrun-abcdefgh",
    customerRef: "u1",
    metadata: { packageHours: "5" },
  });
  // מכאן כל כתיבה לאחסון היא הפרה של "קריאה בלבד"
  let writes = 0;
  const origPut = store.put.bind(store);
  const origPutIfAbsent = store.putIfAbsent.bind(store);
  store.put = (async (...a: Parameters<typeof store.put>) => (writes++, origPut(...a))) as typeof store.put;
  store.putIfAbsent = (async (...a: Parameters<typeof store.putIfAbsent>) => (writes++, origPutIfAbsent(...a))) as typeof store.putIfAbsent;
  calls.length = 0;
  return { provider, store, calls, providerPaymentId: created.providerPaymentId, writes: () => writes, origPutIfAbsent };
}

const payment = (over: Partial<DryRunPayment> = {}): DryRunPayment => ({
  id: "cmabcdefghijklmnopqrstuvw",
  purpose: "PACKAGE",
  status: "PENDING",
  provider: "make-grow",
  providerPaymentId: null,
  amountAgorot: 30000,
  packageHours: 5,
  createdAt: new Date("2026-11-24T10:00:00Z"),
  hasPackage: false,
  ...over,
});

function request(provider: unknown, p: DryRunPayment | null, over: Partial<DryRunRequest> = {}): DryRunRequest {
  return {
    hostname: STAGING_HOST,
    contentType: "application/json",
    rawBody: JSON.stringify({ paymentId: "cmabcdefghijklmnopqrstuvw" }),
    env,
    authorize: async () => "ok",
    provider,
    loadPayment: async () => p,
    listRecent: async () => (p ? [p] : []),
    ...over,
  };
}

const run = async (transactions: unknown, over: Partial<DryRunPayment> = {}) => {
  resetDryRunCooldown();
  const s = await setup(transactions);
  const r = await handleDryRunPost(request(s.provider, payment({ providerPaymentId: s.providerPaymentId, ...over })));
  return { ...s, r, result: r.body.result as Record<string, unknown> };
};

beforeEach(() => resetDryRunCooldown());

test("זמינות והרשאה: מחוץ ל-Staging או בלי הפעלה - 404; לא מחובר 401; לא מנהל 403", async () => {
  const { provider } = await setup([]);
  for (const e of [{ ...env, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }, { ...env, STAGING_GATE_ENABLED: "false" }, { ...env, MAKE_DIAG_ENABLED: undefined }]) {
    assert.equal((await handleDryRunPost(request(provider, payment(), { env: e }))).status, 404);
  }
  assert.equal((await handleDryRunPost(request(provider, payment(), { env: { ...env, MAKE_DIAG_ENABLED: "false" } }))).status, 404);
  assert.equal((await handleDryRunPost(request(provider, payment(), { authorize: async () => "unauthenticated" }))).status, 401);
  assert.equal((await handleDryRunPost(request(provider, payment(), { authorize: async () => "forbidden" }))).status, 403);
  assert.equal((await handleDryRunGet({ hostname: STAGING_HOST, env: { ...env, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }, authorize: async () => "ok", listRecent: async () => [] })).status, 404);
  assert.equal((await handleDryRunGet({ hostname: STAGING_HOST, env, authorize: async () => "forbidden", listRecent: async () => [] })).status, 403);
});

test("בקשה: רק paymentId, בלי שדות נוספים (לא כתובת, לא מזהי Grow)", async () => {
  const { provider } = await setup([]);
  for (const rawBody of ["{}", "[]", "x", JSON.stringify({ paymentId: "cmabcdefghijklmnopqrstuvw", url: "https://evil" }), JSON.stringify({ paymentId: "../x" })]) {
    assert.equal((await handleDryRunPost(request(provider, payment(), { rawBody }))).status, 400, rawBody);
  }
  assert.equal((await handleDryRunPost(request(provider, payment(), { contentType: "text/plain" }))).status, 415);
});

test("תצורה: v2 חסר, קצר, או זהה לתרחיש קיים - 409; ספק שאינו Make - 409; רכישה שאינה חבילה - 404", async () => {
  const { provider, providerPaymentId } = await setup([]);
  const p = payment({ providerPaymentId });
  for (const e of [
    { ...env, MAKE_VERIFY_V2_WEBHOOK_URL: undefined },
    { ...env, MAKE_VERIFY_V2_API_KEY: "short" },
    { ...env, MAKE_VERIFY_V2_WEBHOOK_URL: VERIFY_URL },
    { ...env, MAKE_VERIFY_V2_WEBHOOK_URL: "http://hook.eu1.make.com/x" },
  ]) {
    assert.equal((await handleDryRunPost(request(provider, p, { env: e }))).status, 409);
  }
  assert.equal((await handleDryRunPost(request({ name: "make-grow" }, p))).status, 409);
  assert.equal((await handleDryRunPost(request(provider, payment({ purpose: "BOOKING", providerPaymentId })))).status, 404);
  assert.equal((await handleDryRunPost(request(provider, null))).status, 404);
  const listed = await handleDryRunGet({ hostname: STAGING_HOST, env, authorize: async () => "ok", listRecent: async () => [p] });
  assert.equal(listed.body.configured, true);
  assert.ok(!JSON.stringify(listed.body).includes(providerPaymentId), "מזהה הספק אינו מוצג");
});

test("קריאה בלבד: הבקשה נשלחת רק לתרחיש v2 במפתח שלו, ושום דבר לא נכתב (גם כשיש עסקה ששולמה)", async () => {
  const { result, calls, writes, r } = await run([paidTx("TX1")]);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, V2_URL);
  assert.equal(calls[0].key, V2_KEY);
  assert.equal(writes(), 0);
  assert.equal(result.decision, "ACTIVATE");
  const json = JSON.stringify(r.body);
  for (const secret of ["SECRET-PROCESS-TOKEN", V2_KEY, V2_URL, VERIFY_URL, LINK]) assert.ok(!json.includes(secret), secret);
});

test("מערך ריק: תשובה אחת, 0 עסקאות, החלטה PENDING", async () => {
  const { result } = await run([]);
  assert.equal(result.ok, true);
  assert.equal(result.responseFormat, "v2");
  assert.equal(result.transactionCount, 0);
  assert.equal(result.decision, "PENDING");
});

test("ניסיון שנכשל ואחריו הצלחה: שתי עסקאות, עסקה אחת ששולמה בסכום תואם, החלטה ACTIVATE", async () => {
  const { result } = await run([{ statusCode: "9", sum: "300", paymentLinkProcessId: LINK }, paidTx("TX2")]);
  assert.equal(result.transactionCount, 2);
  assert.deepEqual(result.statusCodes, ["9", "2"]);
  assert.deepEqual(result.paid, [{ transactionId: "TX2", amountAgorot: 30000, amountMatches: true, owner: "free" }]);
  assert.equal(result.linkIdVerified, true);
  assert.equal(result.amountMatches, true);
  assert.equal(result.decision, "ACTIVATE");
});

test("כמה עסקאות ששולמו / החזר / סכום שגוי / רכישה שבוטלה / חבילה שכבר הופעלה", async () => {
  assert.equal((await run([paidTx("A1"), paidTx("B2")])).result.decision, "ACTIVATE + FLAG MULTIPLE_PAID");
  assert.equal((await run([paidTx("A1"), { statusCode: "6", sum: "300", transactionId: "R1", paymentLinkProcessId: LINK }])).result.decision, "REVIEW (REFUNDED)");
  const wrong = (await run([paidTx("A1", "250")])).result;
  assert.equal(wrong.decision, "AMOUNT_MISMATCH");
  assert.equal(wrong.amountMatches, false);
  assert.equal((await run([paidTx("A1")], { status: "CANCELLED" })).result.decision, "REVIEW (PAID_AFTER_CANCEL)");
  assert.equal((await run([paidTx("A1"), paidTx("B2")], { hasPackage: true, status: "SUCCEEDED" })).result.decision, "ALREADY_ACTIVATED + FLAG MULTIPLE_PAID");
});

test("עסקה ששויכה לרכישה אחרת מוצגת ונדחית, בלי לשנות את השיוך", async () => {
  const s = await setup([paidTx("TX9")]);
  await s.origPutIfAbsent("make-tx:TX9", { paymentId: "make:" + "f".repeat(32) });
  const r = await handleDryRunPost(request(s.provider, payment({ providerPaymentId: s.providerPaymentId })));
  const result = r.body.result as { decision: string; paid: { owner: string }[] };
  assert.equal(result.decision, "REJECTED_TRANSACTION_OF_OTHER_PURCHASE");
  assert.equal(result.paid[0].owner, "other");
  assert.equal(s.writes(), 0);
});

test("תשובה לא תקינה / מקישור אחר / מבנה ישן: מוצג בבירור, בלי לחשוף פרטים", async () => {
  const bad = await run([{ ...paidTx("A1"), paymentLinkProcessId: "11111" }]);
  assert.equal(bad.result.ok, false);
  assert.match(String(bad.result.error), /לקישור תשלום אחר/);
  assert.ok(!JSON.stringify(bad.r.body).includes("11111"));

  resetDryRunCooldown();
  const s = await setup(null, (b) => ok({ reference: b.reference, processId: b.processId, statusCode: "2", sum: "300", transactionId: "TX1" }));
  const legacy = (await handleDryRunPost(request(s.provider, payment({ providerPaymentId: s.providerPaymentId })))).body.result as Record<string, unknown>;
  assert.equal(legacy.responseFormat, "legacy");
  assert.equal(legacy.linkIdVerified, false);
});

test("קצב: בדיקה אחת בכל כמה שניות", async () => {
  const s = await setup([]);
  const p = payment({ providerPaymentId: s.providerPaymentId });
  assert.equal((await handleDryRunPost(request(s.provider, p, { now: () => 10_000 }))).status, 200);
  assert.equal((await handleDryRunPost(request(s.provider, p, { now: () => 11_000 }))).status, 429);
});
