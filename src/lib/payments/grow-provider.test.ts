import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore, type MockStore } from "@/lib/payments/mock-store";
import {
  GrowPaymentProvider,
  agorotToShekels,
  assertFullName,
  deriveUniqueIdentifier,
  normalizeIsraeliPhone,
  shekelsToAgorot,
} from "@/lib/payments/grow-provider";
import { PaymentError, PaymentStateError, WebhookVerificationError } from "@/lib/payments/provider";

/**
 * בדיקות ממוקדות ל-GrowPaymentProvider: HTTP מדומה (fetchImpl מוזרק), DB מדומה ואחסון idempotency בזיכרון
 * (InMemoryMockStore, לא Prisma אמיתי) - בלי תלות ברשת או במסד נתונים. מטרת הבדיקות: לאמת את ההתנהגות שאנחנו
 * קובעים (קידוד מזהים, סכומים, מיפוי סטטוסים, "לא מנחשים הצלחה/החזר"), לא את Grow עצמו - לכן תשובות Grow
 * המדומות בבדיקות משתמשות רק בשדות ובקודים שמאומתים בתיעוד (regular-payment-response, parameter-mapping,
 * refund-overview, response-get-payment-info - ראו ההערות ב-grow-provider.ts).
 */

type FakeUser = { name: string; phone: string | null; email?: string | null };

function fakeDb(users: Record<string, FakeUser>): PrismaClient {
  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null,
    },
  } as unknown as PrismaClient;
}

function fakeFetchCapturingBody(routes: Record<string, (form: FormData) => unknown>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.split("/").filter(Boolean).pop() ?? "";
    const handler = routes[path];
    if (!handler) throw new Error(`fakeFetch: no handler registered for "${path}"`);
    const form = init?.body instanceof FormData ? init.body : new FormData();
    return { status: 200, json: async () => handler(form) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const USERS: Record<string, FakeUser> = { u1: { name: "דנה כהן", phone: "0501234567", email: "d@x.com" } };

function makeProvider(
  routes: Record<string, (form: FormData) => unknown>,
  users: Record<string, FakeUser> = USERS,
  store: MockStore = new InMemoryMockStore()
) {
  return new GrowPaymentProvider({
    userId: "biz1",
    pageCode: "page1",
    apiBaseUrl: "https://sandbox.example/api/light/server/1.0/",
    environment: "sandbox",
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    db: fakeDb(users),
    store,
    fetchImpl: fakeFetchCapturingBody(routes),
  });
}

const baseCreate = { amountAgorot: 1099, currency: "ILS" as const, description: "test", customerRef: "u1" };
const OK_PROCESS = { status: "1", err: "", data: { processId: "p1", processToken: "pt1", url: "https://pay.example/abc" } };

// ───────────────────────────── עזרים טהורים ─────────────────────────────

test("agorotToShekels/shekelsToAgorot: המרה דו-כיוונית, דוחה סכום לא תקין", () => {
  assert.equal(agorotToShekels(1099), "10.99");
  assert.equal(shekelsToAgorot("10.99"), 1099);
  assert.equal(shekelsToAgorot(10.99), 1099);
  assert.equal(shekelsToAgorot(undefined), 0);
  assert.throws(() => agorotToShekels(0));
  assert.throws(() => agorotToShekels(1.5));
});

test("deriveUniqueIdentifier: דטרמיניסטי ובטווח בטוח", () => {
  const a = deriveUniqueIdentifier("shiftcharge:x:2026-01:a1");
  const b = deriveUniqueIdentifier("shiftcharge:x:2026-01:a1");
  const c = deriveUniqueIdentifier("shiftcharge:x:2026-01:a2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(Number.isSafeInteger(a) && a >= 0 && a < 1_000_000_000);
});

test("normalizeIsraeliPhone: מקבל 0.../972.../+972..., דוחה לא תקין", () => {
  assert.equal(normalizeIsraeliPhone("0501234567"), "0501234567");
  assert.equal(normalizeIsraeliPhone("+972501234567"), "0501234567");
  assert.equal(normalizeIsraeliPhone("972-50-123-4567"), "0501234567");
  assert.throws(() => normalizeIsraeliPhone(null));
  assert.throws(() => normalizeIsraeliPhone("123"));
});

test("assertFullName: דורש שם ושם משפחה", () => {
  assert.equal(assertFullName("דנה כהן"), "דנה כהן");
  assert.throws(() => assertFullName("דנה"));
  assert.throws(() => assertFullName(null));
});

// ───────────────────────────── createPaymentRequest ─────────────────────────────

test("createPaymentRequest: שולח פרמטרים תקינים ולוקח את קישור התשלום מ-data.url", async () => {
  let received: FormData | undefined;
  const p = makeProvider({
    createPaymentProcess: (form) => {
      received = form;
      return OK_PROCESS;
    },
  });
  const res = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k1" });
  assert.equal(res.status, "PENDING");
  assert.equal(res.checkoutUrl, "https://pay.example/abc");
  assert.ok(res.providerPaymentId.includes("p1"));
  assert.equal(received?.get("sum"), "10.99");
  assert.equal(received?.get("pageField[fullName]"), "דנה כהן");
  assert.equal(received?.get("pageField[phone]"), "0501234567");
  assert.equal(received?.get("saveCardToken"), "0");
  assert.equal(received?.get("chargeType"), "1");
});

test("createPaymentRequest: בלי data.url תקין - שגיאה מבוקרת, לא הצלחה בלי קישור", async () => {
  const p1 = makeProvider({ createPaymentProcess: () => ({ status: "1", err: "", data: { processId: "p1", processToken: "pt1" } }) });
  await assert.rejects(() => p1.createPaymentRequest({ ...baseCreate, idempotencyKey: "k-no-url" }), PaymentError);

  const p2 = makeProvider({ createPaymentProcess: () => ({ status: "1", err: "", data: { processId: "p1", processToken: "pt1", url: "not-a-url" } }) });
  await assert.rejects(() => p2.createPaymentRequest({ ...baseCreate, idempotencyKey: "k-bad-url" }), PaymentError);
});

test("createPaymentRequest: אותו מפתח idempotency לא קורא ל-Grow פעמיים; מפתח עם פרמטרים אחרים נדחה", async () => {
  let calls = 0;
  const p = makeProvider({
    createPaymentProcess: () => {
      calls++;
      return OK_PROCESS;
    },
  });
  const a = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "same-key-1" });
  const b = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "same-key-1" });
  assert.equal(a.providerPaymentId, b.providerPaymentId);
  assert.equal(calls, 1);
  await assert.rejects(() => p.createPaymentRequest({ ...baseCreate, amountAgorot: 500, idempotencyKey: "same-key-1" }), PaymentError);
});

test("createPaymentRequest: ה-idempotency שורד 'הפעלה מחדש' (מופע חדש עם אותו store עמיד)", async () => {
  const store = new InMemoryMockStore();
  let calls = 0;
  const routes = {
    createPaymentProcess: () => {
      calls++;
      return OK_PROCESS;
    },
  };
  const first = makeProvider(routes, USERS, store);
  const a = await first.createPaymentRequest({ ...baseCreate, idempotencyKey: "restart-key" });

  // מופע חדש לחלוטין (מדמה תהליך Node שהופעל מחדש), אבל עם אותו store עמיד
  const second = makeProvider(routes, USERS, store);
  const b = await second.createPaymentRequest({ ...baseCreate, idempotencyKey: "restart-key" });

  assert.equal(a.providerPaymentId, b.providerPaymentId);
  assert.equal(calls, 1, "לא נוצר תהליך Grow שני אחרי 'הפעלה מחדש'");
});

test("createPaymentRequest: תחרות אמיתית - שתי בקשות מקבילות עם מפתח חדש זהה קוראות ל-Grow פעם אחת בלבד ומקבלות תוצאה זהה", async () => {
  let calls = 0;
  const p = makeProvider({
    createPaymentProcess: () => {
      calls++;
      return OK_PROCESS;
    },
  });
  const [a, b] = await Promise.all([
    p.createPaymentRequest({ ...baseCreate, idempotencyKey: "race-key" }),
    p.createPaymentRequest({ ...baseCreate, idempotencyKey: "race-key" }),
  ]);
  assert.equal(calls, 1, "לא נוצרו שני תהליכי Grow למרוץ על מפתח אחד");
  assert.equal(a.providerPaymentId, b.providerPaymentId);
});

test("createPaymentRequest: בקשה שהפסידה במרוץ (אפילו ממופע שרת אחר) מקבלת את תוצאת הזוכה אחרי המתנה קצרה, ולא קוראת ל-Grow בעצמה", async () => {
  const store = new InMemoryMockStore();
  let calls = 0;
  const slowWinner = makeProvider(
    {
      createPaymentProcess: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return OK_PROCESS;
      },
    },
    USERS,
    store
  );
  const mustNotCall = makeProvider(
    { createPaymentProcess: () => { throw new Error("second instance must not call Grow itself"); } },
    USERS,
    store
  );
  const [a, b] = await Promise.all([
    slowWinner.createPaymentRequest({ ...baseCreate, idempotencyKey: "slow-winner-key" }),
    mustNotCall.createPaymentRequest({ ...baseCreate, idempotencyKey: "slow-winner-key" }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.providerPaymentId, b.providerPaymentId);
});

test("createPaymentRequest: תפיסה שננטשה (כשל ודאי בניסיון קודם) נדרשת בבירור מפורש - לא תפיסה-מחדש אוטומטית שעלולה לכפול", async () => {
  const store = new InMemoryMockStore();
  const fingerprint = JSON.stringify([baseCreate.amountAgorot, baseCreate.currency, baseCreate.customerRef, false]);
  await store.put("grow-create:abandoned-key", { fingerprint, result: null, claimedAt: 0 });
  const p = makeProvider({ createPaymentProcess: () => { throw new Error("must not call Grow for an abandoned claim"); } }, USERS, store);
  await assert.rejects(() => p.createPaymentRequest({ ...baseCreate, idempotencyKey: "abandoned-key" }), PaymentError);
});

test("createPaymentRequest: תשובה בלי processId/processToken נכשלת בבירור, לא מנחשים שדה", async () => {
  const p = makeProvider({ createPaymentProcess: () => ({ status: "1", err: "", data: { url: "https://pay.example/x" } }) });
  await assert.rejects(() => p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k2" }), PaymentError);
});

test("createPaymentRequest: מסרב לקרוא ל-Grow בלי טלפון/שם תקינים של הלקוח", async () => {
  const p = makeProvider(
    { createPaymentProcess: () => { throw new Error("should not be called"); } },
    { u2: { name: "דנה", phone: null } }
  );
  await assert.rejects(() => p.createPaymentRequest({ ...baseCreate, customerRef: "u2", idempotencyKey: "k3" }), PaymentError);
});

// ───────────────────────────── getPaymentStatus: מיפוי קודי סטטוס (parameter-mapping) ─────────────────────────────

test("getPaymentStatus (process ref): 2=שולם -> SUCCEEDED, וטוקן נחשף רק בהסכמה מפורשת", async () => {
  const withConsent = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({
      status: "1",
      err: "",
      data: { transactions: [{ statusCode: "2", sum: "15.50", cardToken: "ctok", cardSuffix: "1234", cardBrand: "Visa", cardExp: "1230" }] },
    }),
  });
  const created = await withConsent.createPaymentRequest({ ...baseCreate, amountAgorot: 1550, savePaymentMethod: true, idempotencyKey: "k4" });
  const status = await withConsent.getPaymentStatus(created.providerPaymentId);
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.amountAgorot, 1550);
  assert.equal(status.savedPaymentMethod?.token, "ctok");
  assert.equal(status.savedPaymentMethod?.expiry, "12/30");
});

test("getPaymentStatus (process ref): בלי savePaymentMethod=true ביצירה, לעולם לא נחשף טוקן - גם אם Grow מחזיר cardToken", async () => {
  const noConsent = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [{ statusCode: "2", sum: "15.50", cardToken: "ctok" }] } }),
  });
  const created = await noConsent.createPaymentRequest({ ...baseCreate, idempotencyKey: "k4b" });
  const status = await noConsent.getPaymentStatus(created.providerPaymentId);
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.savedPaymentMethod, undefined);
});

test("getPaymentStatus (process ref): 9=נדחתה -> FAILED, 4=בוטלה לפני שידור -> CANCELLED", async () => {
  const denied = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [{ statusCode: "9", sum: "10.00" }] } }),
  });
  const createdDenied = await denied.createPaymentRequest({ ...baseCreate, idempotencyKey: "k-denied" });
  assert.equal((await denied.getPaymentStatus(createdDenied.providerPaymentId)).status, "FAILED");

  const cancelled = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [{ statusCode: "4", sum: "10.00" }] } }),
  });
  const createdCancelled = await cancelled.createPaymentRequest({ ...baseCreate, idempotencyKey: "k-cancelled" });
  assert.equal((await cancelled.getPaymentStatus(createdCancelled.providerPaymentId)).status, "CANCELLED");
});

test("getPaymentStatus (process ref): קוד סטטוס לא מוכר (לא בטבלת parameter-mapping) נשאר PENDING ולא מתפרש כהצלחה/כישלון", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [{ statusCode: "77", sum: "15.50" }] } }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k5" });
  assert.equal((await p.getPaymentStatus(created.providerPaymentId)).status, "PENDING");
});

test("getPaymentStatus (process ref): אין עדיין עסקאות = PENDING", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [] } }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k6" });
  assert.equal((await p.getPaymentStatus(created.providerPaymentId)).status, "PENDING");
});

test("getPaymentStatus (process ref): סכום ההחזר מחושב משורות statusCode=6 (רישום החזר), לא מנוחש כמלא", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({
      status: "1",
      err: "",
      data: {
        transactions: [
          { statusCode: "2", sum: "20.00" },
          { statusCode: "6", sum: "5.00" },
        ],
      },
    }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, amountAgorot: 2000, idempotencyKey: "k-refund-entry" });
  const status = await p.getPaymentStatus(created.providerPaymentId);
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.amountAgorot, 2000);
  assert.equal(status.refundedAgorot, 500);
});

// ───────────────────────────── chargeSavedMethod ─────────────────────────────

const baseCharge = { token: "tok-abc", amountAgorot: 2000, currency: "ILS" as const, description: "charge", customerRef: "u1" };

test("chargeSavedMethod: הצלחה ממופה לעסקה (tx ref)", async () => {
  const p = makeProvider({
    getTokenTransactionsByExternalIdentifiers: () => ({ status: "0", err: { id: "404", message: "not found" } }),
    createTransactionWithToken: (form) => {
      assert.equal(form.get("cardToken"), "tok-abc");
      assert.equal(form.get("paymentType"), "2");
      assert.ok(form.get("transactionUniqueIdentifier"));
      return { status: "1", err: "", data: { transactionId: "tx1", transactionToken: "tt1" } };
    },
  });
  const res = await p.chargeSavedMethod({ ...baseCharge, idempotencyKey: "charge-1" });
  assert.equal(res.status, "SUCCEEDED");
});

test("chargeSavedMethod: דחייה מ-Grow היא FAILED ודאי, לא UNKNOWN - ואין צורך בקריאה נוספת כדי לדעת זאת", async () => {
  const p = makeProvider({
    getTokenTransactionsByExternalIdentifiers: () => ({ status: "0", err: "" }),
    createTransactionWithToken: () => ({ status: "0", err: { id: "210", message: "card declined" } }),
  });
  const res = await p.chargeSavedMethod({ ...baseCharge, idempotencyKey: "charge-2" });
  assert.equal(res.status, "FAILED");
  assert.ok(res.failureCode?.includes("210"));
  const status = await p.getPaymentStatus(res.providerPaymentId);
  assert.equal(status.status, "FAILED");
});

test("chargeSavedMethod: אם חיוב עם אותו מזהה ייחודי כבר קיים ב-Grow, מחזירים אותו ולא מחייבים שוב", async () => {
  let chargeCalls = 0;
  const p = makeProvider({
    getTokenTransactionsByExternalIdentifiers: () => ({
      status: "1",
      err: "",
      data: { transactions: [{ transactionId: "tx-old", transactionToken: "tt-old", statusCode: "2" }] },
    }),
    createTransactionWithToken: () => {
      chargeCalls++;
      return { status: "1", err: "", data: { transactionId: "tx-new", transactionToken: "tt-new" } };
    },
  });
  const res = await p.chargeSavedMethod({ ...baseCharge, idempotencyKey: "charge-3" });
  assert.equal(chargeCalls, 0);
  assert.equal(res.status, "SUCCEEDED");
});

test("chargeSavedMethod: status=1 אך data.statusCode שונה מ-2 ('שולם', token-transactions-response) - לא הצלחה אוטומטית", async () => {
  const p = makeProvider({
    getTokenTransactionsByExternalIdentifiers: () => ({ status: "0", err: "" }),
    createTransactionWithToken: () => ({ status: "1", err: "", data: { transactionId: "tx1", transactionToken: "tt1", statusCode: "9" } }),
  });
  await assert.rejects(() => p.chargeSavedMethod({ ...baseCharge, idempotencyKey: "mismatch-1" }), PaymentError);
});

// ───────────────────────────── cancelPayment ─────────────────────────────

test("cancelPayment: no-op כשאין עדיין עסקה מוצלחת אצל Grow", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [] } }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k7" });
  await assert.doesNotReject(() => p.cancelPayment(created.providerPaymentId));
});

test("cancelPayment: נכשל אם Grow כבר קלט תשלום מוצלח", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [{ statusCode: "2", sum: "5.00" }] } }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k8" });
  await assert.rejects(() => p.cancelPayment(created.providerPaymentId), PaymentStateError);
});

// ───────────────────────────── refund (refund-overview: אותו יום = בלי חלקי; מקסימום 2 דרך ה-API) ─────────────────────────────

test("refund: tx ref מחזיר ישירות (עסקה לא מאותו יום בדוגמה - paymentDate לא קיים ב-createTransactionWithToken)", async () => {
  const p = makeProvider({
    getTokenTransactionsByExternalIdentifiers: () => ({ status: "0", err: "" }),
    createTransactionWithToken: () => ({ status: "1", err: "", data: { transactionId: "tx1", transactionToken: "tt1" } }),
    getTransactionInfo: () => ({ status: "1", err: "", data: { sum: "5.00" } }),
    refundTransaction: (form) => {
      assert.equal(form.get("transactionId"), "tx1");
      assert.equal(form.get("refundSum"), "5.00");
      return { status: "1", err: "", data: { refundedTransactionId: "tx1" } };
    },
  });
  const charge = await p.chargeSavedMethod({ ...baseCharge, amountAgorot: 500, idempotencyKey: "c1" });
  const refund = await p.refund({ providerPaymentId: charge.providerPaymentId, amountAgorot: 500, idempotencyKey: "r1" });
  assert.equal(refund.status, "SUCCEEDED");
  assert.equal(refund.amountAgorot, 500);
});

test("refund: process ref מאתר קודם את העסקה ששולמה", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({
      status: "1",
      err: "",
      data: { transactions: [{ statusCode: "2", transactionId: "tx9", transactionToken: "tt9", sum: "20.00", paymentDate: "01/01/20" }] },
    }),
    refundTransaction: (form) => {
      assert.equal(form.get("transactionId"), "tx9");
      return { status: "1", err: "", data: {} };
    },
  });
  const created = await p.createPaymentRequest({ ...baseCreate, amountAgorot: 2000, idempotencyKey: "k9" });
  const refund = await p.refund({ providerPaymentId: created.providerPaymentId, amountAgorot: 1000, idempotencyKey: "r2" });
  assert.equal(refund.amountAgorot, 1000);
});

test("refund: תהליך בלי עסקה ששולמה - אין מה להחזיר", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({ status: "1", err: "", data: { transactions: [] } }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, idempotencyKey: "k10" });
  await assert.rejects(() => p.refund({ providerPaymentId: created.providerPaymentId, amountAgorot: 100, idempotencyKey: "r3" }), PaymentStateError);
});

test("refund: עסקה מאותו יום - לא ניתן להחזיר סכום חלקי (רק מלא/ביטול)", async () => {
  const today = new Date();
  const todayDDMMYY = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getFullYear() % 100).padStart(2, "0")}`;
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({
      status: "1",
      err: "",
      data: { transactions: [{ statusCode: "2", transactionId: "tx9", transactionToken: "tt9", sum: "20.00", paymentDate: todayDDMMYY }] },
    }),
    refundTransaction: () => {
      throw new Error("refundTransaction must not be called for a same-day partial refund");
    },
  });
  const created = await p.createPaymentRequest({ ...baseCreate, amountAgorot: 2000, idempotencyKey: "k-sameday" });
  await assert.rejects(
    () => p.refund({ providerPaymentId: created.providerPaymentId, amountAgorot: 1000, idempotencyKey: "r-sameday" }),
    PaymentStateError
  );
});

test("refund: עסקה מאותו יום - החזר מלא כן מותר (זה למעשה ביטול)", async () => {
  const today = new Date();
  const todayDDMMYY = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getFullYear() % 100).padStart(2, "0")}`;
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({
      status: "1",
      err: "",
      data: { transactions: [{ statusCode: "2", transactionId: "tx9", transactionToken: "tt9", sum: "20.00", paymentDate: todayDDMMYY }] },
    }),
    refundTransaction: () => ({ status: "1", err: "", data: {} }),
  });
  const created = await p.createPaymentRequest({ ...baseCreate, amountAgorot: 2000, idempotencyKey: "k-sameday-full" });
  const refund = await p.refund({ providerPaymentId: created.providerPaymentId, amountAgorot: 2000, idempotencyKey: "r-sameday-full" });
  assert.equal(refund.status, "SUCCEEDED");
});

test("refund: לאחר שני החזרים (statusCode=6) דרך ה-API, השלישי נדחה מקומית בלי לפנות ל-Grow", async () => {
  const p = makeProvider({
    createPaymentProcess: () => OK_PROCESS,
    getPaymentProcessInfo: () => ({
      status: "1",
      err: "",
      data: {
        transactions: [
          { statusCode: "2", transactionId: "tx9", transactionToken: "tt9", sum: "20.00", paymentDate: "01/01/20" },
          { statusCode: "6", sum: "5.00" },
          { statusCode: "6", sum: "5.00" },
        ],
      },
    }),
    refundTransaction: () => {
      throw new Error("refundTransaction must not be called past the 2-refund API limit");
    },
  });
  const created = await p.createPaymentRequest({ ...baseCreate, amountAgorot: 2000, idempotencyKey: "k-maxrefund" });
  await assert.rejects(
    () => p.refund({ providerPaymentId: created.providerPaymentId, amountAgorot: 500, idempotencyKey: "r-third" }),
    PaymentStateError
  );
});

// ───────────────────────────── parseWebhook ─────────────────────────────

const WEBHOOK_DATA = {
  transactionId: "tx1", transactionToken: "tt1", transactionTypeId: "1", paymentType: "2", sum: "10.00",
  firstPaymentSum: "10.00", periodicalPaymentSum: "0", paymentsNum: "1", allPaymentsNum: "1", paymentDate: "01/01/26",
  asmachta: "123456", description: "d", fullName: "דנה כהן", payerPhone: "0501234567", payerEmail: "a@b.com",
  cardSuffix: "1234", cardType: "Local", cardTypeCode: "1", cardBrand: "Visa", cardBrandCode: "3", cardExp: "1230",
  processId: "p1", processToken: "pt1", statusCode: "2",
};

test("parseWebhook: מפענח JSON ומבצע approveTransaction כשכל השדות הדרושים קיימים", async () => {
  let approveForm: FormData | undefined;
  const p = makeProvider({
    approveTransaction: (form) => {
      approveForm = form;
      return { status: "1", err: "", data: {} };
    },
  });
  const event = await p.parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(event.type, "payment.updated");
  assert.ok(event.providerPaymentId.includes("p1"));
  assert.ok(approveForm);
  assert.equal(approveForm?.get("asmachta"), "123456");
});

test("parseWebhook: אותה התראה פעמיים (retry של Grow) מבצעת approveTransaction פעם אחת בלבד", async () => {
  const store = new InMemoryMockStore();
  let approveCalls = 0;
  const routes = {
    approveTransaction: () => {
      approveCalls++;
      return { status: "1", err: "", data: {} };
    },
  };
  const first = makeProvider(routes, USERS, store);
  await first.parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  // מופע חדש (מדמה ריצה אחרת/תהליך שהופעל מחדש), אותו store עמיד - כמו retry אמיתי של webhook
  const second = makeProvider(routes, USERS, store);
  await second.parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(approveCalls, 1);
});

test("parseWebhook: כשל ב-approveTransaction (זמני/status=0) לעולם לא נרשם כאישור מוצלח - ניסיון חוזר עדיין מנסה שוב, ורק הצלחה מאומתת עוצרת ניסיונות הבאים", async () => {
  const store = new InMemoryMockStore();
  let attempt = 0;
  const routes = {
    approveTransaction: () => {
      attempt++;
      if (attempt === 1) return { status: "0", err: { id: "500", message: "temporary" } };
      return { status: "1", err: "", data: {} };
    },
  };
  await makeProvider(routes, USERS, store).parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(attempt, 1);

  // ניסיון חוזר (webhook נוסף, אפילו ממופע אחר) - עדיין מנסה, כי הניסיון הקודם לא אומת כהצלחה
  await makeProvider(routes, USERS, store).parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(attempt, 2);

  // אחרי הצלחה מאומתת - אין ניסיון שלישי
  await makeProvider(routes, USERS, store).parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(attempt, 2);
});

test("parseWebhook: כשל תקשורת (throw) ב-approveTransaction גם הוא לא נרשם כאישור מוצלח", async () => {
  const store = new InMemoryMockStore();
  let attempt = 0;
  const routes = {
    approveTransaction: () => {
      attempt++;
      if (attempt === 1) throw new Error("network error");
      return { status: "1", err: "", data: {} };
    },
  };
  await makeProvider(routes, USERS, store).parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(attempt, 1);
  await makeProvider(routes, USERS, store).parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: WEBHOOK_DATA }), headers: {} });
  assert.equal(attempt, 2, "ניסיון חוזר מותר אחרי כשל תקשורת");
});

test("parseWebhook: asmachta חסר - מדלגים על approveTransaction בלי לזרוק (לפי התיעוד זה לא חוסם את התשלום)", async () => {
  let approveCalled = false;
  const p = makeProvider({ approveTransaction: () => { approveCalled = true; return { status: "1", err: "", data: {} }; } });
  const data = { transactionId: "tx1", transactionToken: "tt1", processId: "p1", processToken: "pt1", statusCode: "2" };
  const event = await p.parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data }), headers: {} });
  assert.ok(event.providerPaymentId.includes("p1"));
  assert.equal(approveCalled, false);
});

test("parseWebhook: גוף שלא ניתן לפענח או שחסרים בו שדות מזהים נדחה כחתימה לא תקינה", async () => {
  const p = makeProvider({});
  await assert.rejects(() => p.parseWebhook({ rawBody: JSON.stringify({ status: "1", err: "", data: { foo: "bar" } }), headers: {} }), WebhookVerificationError);
});

test("parseWebhook: אין approveTransaction לחיובי טוקן - chargeSavedMethod לא עובר דרך parseWebhook כלל", async () => {
  // זהו תיעוד-בדיקה של ההנחיה (לא טעינת פונקציונליות חדשה): chargeSavedMethod מחזיר תוצאה סינכרונית
  // ישירות מ-createTransactionWithToken, ואינו קורא בשום מקום ל-parseWebhook/approveTransaction.
  const p = makeProvider({
    getTokenTransactionsByExternalIdentifiers: () => ({ status: "0", err: "" }),
    createTransactionWithToken: () => ({ status: "1", err: "", data: { transactionId: "tx1", transactionToken: "tt1" } }),
    approveTransaction: () => {
      throw new Error("approveTransaction must never be called for a token charge");
    },
  });
  const res = await p.chargeSavedMethod({ ...baseCharge, idempotencyKey: "no-approve-1" });
  assert.equal(res.status, "SUCCEEDED");
});
