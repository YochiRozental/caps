import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import { MakeGrowPaymentProvider, parseVerifyTransactions } from "@/lib/payments/make-provider";
import { PaymentError, type PaymentProvider } from "@/lib/payments/provider";
import { isTransientVerifyFailure } from "@/lib/payments/verify-errors";

/**
 * תרחיש אימות v2: Make מחזיר את כל העסקאות של קישור התשלום כמערך JSON, כל עסקה כאובייקט אחד (statusCode, sum,
 * transactionId ו-paymentLinkProcessId יחד). הבחירה נעשית בקוד. כולל תאימות לאחור למבנה הישן (עסקה אחת).
 */

const HOOK = "https://hook.eu1.make.com/create-abc";
const VERIFY_HOOK = "https://hook.eu1.make.com/verify-v2";
const LINK = "82439"; // מזהה קישור התשלום שנשמר בשרת ביצירה
const db = {
  user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: "d@x.com" }) },
} as unknown as PrismaClient;

type Body = Record<string, string>;
type Tx = Record<string, unknown>;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const paidTx = (transactionId: string, sum: unknown = "300", over: Tx = {}): Tx => ({ statusCode: "2", sum, transactionId, paymentLinkProcessId: LINK, ...over });
const declined = (over: Tx = {}): Tx => ({ statusCode: "9", sum: "300", transactionId: "", paymentLinkProcessId: LINK, ...over });

/** תשובת v2 כפי שהתרחיש בונה: format + reference + processId + grow (פלט Create JSON) */
const v2 = (transactions: unknown, extra: Record<string, unknown> = {}) => (b: Body) =>
  ok({ format: "v2", reference: b.reference, processId: b.processId, grow: { transactions }, ...extra });

function setup() {
  const state: { verify: (b: Body) => Response } = { verify: v2([]) };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    if (String(url) === VERIFY_HOOK) return state.verify(body);
    return ok({ url: "https://pay.grow.example/abc", processId: LINK, processToken: "T1" });
  }) as unknown as typeof fetch;
  const p = new MakeGrowPaymentProvider({
    webhookUrl: HOOK,
    apiKey: "k".repeat(32),
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    verify: { webhookUrl: VERIFY_HOOK, apiKey: "v".repeat(32) },
    returnBaseUrl: "https://caps-staging-ppb1.onrender.com",
    db,
    store: new InMemoryMockStore(),
    fetchImpl,
    timeoutMs: 500,
  }) as PaymentProvider;
  return { p, state };
}

let n = 0;
const purchase = (p: PaymentProvider) =>
  p.createPaymentRequest({
    amountAgorot: 30000,
    currency: "ILS",
    description: "חבילת 5 שעות",
    idempotencyKey: `package:u1:key-${n++}-abcdefgh`,
    customerRef: "u1",
    metadata: { packageHours: "5" },
  });

const parse = (transactions: unknown) => parseVerifyTransactions({ format: "v2", grow: { transactions } }, LINK);

// ───── פענוח טהור ─────

test("v2: מערך ריק או חסר = אין עסקאות", () => {
  assert.deepEqual(parse([]), { format: "v2", statusCodes: [], paid: [], refunds: [] });
  assert.deepEqual(parseVerifyTransactions({ format: "v2", grow: {} }, LINK).paid, []);
});

test("v2: ניסיון שנכשל ואחריו ניסיון מוצלח - נבחרת העסקה ששולמה, עם הסכום והמזהה מאותו אובייקט", () => {
  const view = parse([declined(), paidTx("573688")]);
  assert.deepEqual(view.paid, [{ transactionId: "573688", amountAgorot: 30000 }]);
  assert.deepEqual(view.statusCodes, ["9", "2"]);
  // מספרים (לא מחרוזות) מתקבלים באותו אופן
  assert.deepEqual(parse([{ statusCode: 2, sum: 300, transactionId: 573688, paymentLinkProcessId: 82439 }]).paid, [{ transactionId: "573688", amountAgorot: 30000 }]);
});

test("v2: כמה ניסיונות כושלים / ממתין / בוטל לפני שידור - אין תשלום ואין החזר", () => {
  for (const codes of [["9"], ["9", "9", "9"], ["0"], ["4"], ["9", "4", "0"]]) {
    const view = parse(codes.map((statusCode) => ({ statusCode, sum: "300" })));
    assert.deepEqual(view.paid, [], codes.join());
    assert.deepEqual(view.refunds, [], codes.join());
  }
});

test("v2: החזר (6) מזוהה בנפרד מדחייה (9), גם לצד עסקה ששולמה", () => {
  const view = parse([paidTx("A1"), { statusCode: "6", sum: "-300", transactionId: "R1", paymentLinkProcessId: LINK }]);
  assert.deepEqual(view.paid, [{ transactionId: "A1", amountAgorot: 30000 }]);
  assert.deepEqual(view.refunds, [{ transactionId: "R1", amountAgorot: 30000 }]);
  assert.deepEqual(parse([declined()]).refunds, []);
});

test("v2: שתי עסקאות ששולמו מזוהות שתיהן; אותה עסקה פעמיים נספרת פעם אחת", () => {
  assert.equal(parse([paidTx("A1"), declined(), paidTx("B2", "300.00")]).paid.length, 2);
  assert.deepEqual(parse([paidTx("A1"), paidTx("A1")]).paid, [{ transactionId: "A1", amountAgorot: 30000 }]);
});

test("v2: קשירה לנתון של Grow - עסקה ששולמה או הוחזרה חייבת לשאת את מזהה הקישור שנשמר בשרת", () => {
  assert.throws(() => parse([paidTx("A1", "300", { paymentLinkProcessId: "99999" })]), /לקישור תשלום אחר/);
  assert.throws(() => parse([paidTx("A1", "300", { paymentLinkProcessId: undefined })]), /מזהה קישור/);
  assert.throws(() => parse([{ statusCode: "6", sum: "300", transactionId: "R1" }]), /מזהה קישור/);
  // עסקה שלא שולמה מקישור אחר היא גם סימן שהתשובה אינה של הקישור הזה
  assert.throws(() => parse([declined({ paymentLinkProcessId: "99999" })]), /לקישור תשלום אחר/);
  // עסקה שלא שולמה בלי מזהה קישור - מותר (אין בה כסף)
  assert.deepEqual(parse([declined({ paymentLinkProcessId: undefined })]).paid, []);
});

test("v2: תשובה לא תקינה נדחית", () => {
  const bad: unknown[] = [
    "not-an-array",
    { a: 1 },
    [null],
    ["2"],
    [[paidTx("A1")]],
    [{ sum: "300", transactionId: "A1", paymentLinkProcessId: LINK }], // בלי statusCode
    [{ statusCode: "x2", paymentLinkProcessId: LINK }],
    [paidTx("A1", "0")],
    [paidTx("A1", "abc")],
    [paidTx("")],
    [paidTx("A 1")],
    [paidTx("<script>")],
    [paidTx("A1"), paidTx("A1", "250")], // אותה עסקה בשני סכומים
    Array.from({ length: 51 }, () => declined()),
  ];
  for (const transactions of bad) assert.throws(() => parse(transactions), PaymentError, JSON.stringify(transactions).slice(0, 80));
  assert.throws(() => parseVerifyTransactions({ format: "v2" }, LINK), PaymentError);
  assert.throws(() => parseVerifyTransactions({ format: "v2", grow: "[]" }, LINK), PaymentError);
});

test("legacy (התרחיש הישן): עסקה אחת, אותם כללים כמו קודם; 6 מזוהה כהחזר ולא כתשלום", () => {
  assert.deepEqual(parseVerifyTransactions({ statusCode: "2", sum: "300", transactionId: 573688 }, LINK).paid, [{ transactionId: "573688", amountAgorot: 30000 }]);
  assert.deepEqual(parseVerifyTransactions({ statusCode: "9", sum: "300", transactionId: "1" }, LINK).paid, []);
  assert.deepEqual(parseVerifyTransactions({}, LINK).paid, []);
  const refund = parseVerifyTransactions({ statusCode: "6", sum: "300", transactionId: "573688" }, LINK);
  assert.deepEqual(refund.paid, []);
  assert.deepEqual(refund.refunds, [{ transactionId: "573688", amountAgorot: 30000 }]);
  assert.throws(() => parseVerifyTransactions({ statusCode: "2", sum: "300" }, LINK), PaymentError);
});

// ───── דרך הספק (HTTP מדומה) ─────

test("ספק v2: רשימה ריקה / ניסיונות כושלים = PENDING בסכום שביקשנו, בלי החזר", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  for (const verify of [v2([]), v2([declined()]), v2([declined(), { statusCode: "4", paymentLinkProcessId: LINK }])]) {
    state.verify = verify;
    const s = await p.getPaymentStatus(r.providerPaymentId);
    assert.equal(s.status, "PENDING");
    assert.equal(s.amountAgorot, 30000);
    assert.equal(s.refundObserved, undefined);
  }
});

test("ספק v2: נכשל ואז הצליח - SUCCEEDED עם הסכום והמזהה של העסקה ששולמה", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  state.verify = v2([declined(), paidTx("TX2")]);
  const s = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(s.status, "SUCCEEDED");
  assert.equal(s.amountAgorot, 30000);
  assert.deepEqual(s.paidTransactions, [{ transactionId: "TX2", amountAgorot: 30000 }]);
});

test("ספק v2: חיוב מרובה - כל העסקאות מוחזרות, והסכום הנבחר הוא של עסקה בסכום הצפוי", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  state.verify = v2([paidTx("A1", "250"), paidTx("B2", "300")]);
  const s = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(s.amountAgorot, 30000);
  assert.equal(s.paidTransactions?.length, 2);
});

test("ספק v2: החזר מסומן (refundObserved + סכום) גם כשיש עסקה ששולמה, וגם כשאין", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  state.verify = v2([paidTx("A1"), { statusCode: "6", sum: "300", transactionId: "R1", paymentLinkProcessId: LINK }]);
  const s = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(s.status, "SUCCEEDED");
  assert.equal(s.refundObserved, true);
  assert.equal(s.refundedAgorot, 30000);
  assert.deepEqual(s.refundTransactions, [{ transactionId: "R1", amountAgorot: 30000 }]);

  const r2 = await purchase(p);
  state.verify = v2([{ statusCode: "6", sum: "", paymentLinkProcessId: LINK }]);
  const only = await p.getPaymentStatus(r2.providerPaymentId);
  assert.equal(only.status, "PENDING");
  assert.equal(only.refundObserved, true);
  assert.deepEqual(only.refundTransactions, [{ transactionId: "refund-1", amountAgorot: 0 }]);
});

test("ספק v2: עסקה ששויכה לרכישה אחרת חוסמת את האימות, גם כשהיא אחת מכמה עסקאות ששולמו", async () => {
  const { p, state } = setup();
  const first = await purchase(p);
  state.verify = v2([paidTx("A1")]);
  assert.equal((await p.getPaymentStatus(first.providerPaymentId)).status, "SUCCEEDED");
  const second = await purchase(p);
  state.verify = v2([paidTx("B2"), paidTx("A1")]);
  await assert.rejects(p.getPaymentStatus(second.providerPaymentId), /שויך לתשלום אחר/);
  state.verify = v2([paidTx("A1")]);
  assert.equal((await p.getPaymentStatus(first.providerPaymentId)).status, "SUCCEEDED");
});

test("ספק v2: תשובה לא תקינה או מקישור אחר = כשל אימות זמני (בלי שינוי מצב), לא סטטוס", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  for (const verify of [
    v2([paidTx("A1", "300", { paymentLinkProcessId: "11111" })]),
    v2("[]"),
    v2([{ sum: "300" }]),
    (b: Body) => ok({ format: "v2", reference: b.reference, processId: b.processId }),
  ]) {
    state.verify = verify;
    const err = await p.getPaymentStatus(r.providerPaymentId).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof PaymentError, "צפויה שגיאה");
    assert.ok(isTransientVerifyFailure(err));
  }
});

test("ספק v2: reference / processId / מטבע ממשיכים להיבדק", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  state.verify = (b) => v2([paidTx("A1")])({ ...b, reference: "make:" + "0".repeat(32) });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינה תואמת/);
  state.verify = (b) => v2([paidTx("A1")])({ ...b, processId: "OTHER" });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /אינה מזהה/);
  state.verify = v2([paidTx("A1")], { currency: "USD" });
  await assert.rejects(p.getPaymentStatus(r.providerPaymentId), /ILS/);
});

test("חזרה לתרחיש הישן: אותו תשלום מאומת גם במבנה legacy, ועסקה שכבר שויכה ב-v2 מוכרת", async () => {
  const { p, state } = setup();
  const r = await purchase(p);
  state.verify = v2([paidTx("573688")]);
  assert.equal((await p.getPaymentStatus(r.providerPaymentId)).status, "SUCCEEDED");
  state.verify = (b) => ok({ reference: b.reference, processId: b.processId, currency: "ILS", statusCode: "2", sum: "300", transactionId: "573688" });
  const s = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(s.status, "SUCCEEDED");
  assert.deepEqual(s.paidTransactions, [{ transactionId: "573688", amountAgorot: 30000 }]);
});
