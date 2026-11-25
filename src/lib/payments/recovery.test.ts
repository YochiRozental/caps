import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import { MakeGrowPaymentProvider } from "@/lib/payments/make-provider";
import { PaymentError, PaymentStateError, type PaymentProvider, type PaymentRequestResult } from "@/lib/payments/provider";
import {
  RECOVERY_MAX_AGE_MS,
  RECOVERY_MIN_AGE_MS,
  recheckIntervalMs,
  recoveryLogLine,
  runPaymentRecovery,
  type RecoveryCandidate,
  type RecoveryDeps,
} from "@/lib/payments/recovery";

/**
 * התאוששות תשלומים ממתינים בשרת: בודקת רק בחלון הזמן, עם השהיה שגדלה עם הגיל, עוברת תמיד דרך finalize הקיים,
 * ולעולם לא יוצרת בקשת תשלום (קישור) חדשה.
 */

const MIN = 60_000;
const NOW = new Date("2026-11-25T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** ספק שכל פעולה שיוצרת או מחייבת בו נכשלת את הבדיקה */
function provider(extra: Partial<PaymentProvider> & { findExistingPaymentRequest?: (k: string) => Promise<PaymentRequestResult | null> } = {}) {
  const forbidden = () => {
    throw new Error("forbidden: recovery must not create or charge");
  };
  return {
    name: "make-grow",
    environment: "sandbox",
    createPaymentRequest: forbidden,
    getPaymentStatus: forbidden,
    cancelPayment: forbidden,
    refund: forbidden,
    chargeSavedMethod: forbidden,
    parseWebhook: forbidden,
    ...extra,
  } as unknown as PaymentProvider;
}

function deps(candidates: RecoveryCandidate[], finalize: (id: string) => Promise<{ outcome: string }> = async () => ({ outcome: "PENDING" })) {
  const calls = { list: [] as { from: Date; to: Date; take: number }[], finalized: [] as string[], attached: [] as [string, string][] };
  const d: RecoveryDeps = {
    listCandidates: async (args) => {
      calls.list.push(args);
      return candidates;
    },
    finalize: async (id) => {
      calls.finalized.push(id);
      return finalize(id);
    },
    attachProviderRef: async (id, ref) => {
      calls.attached.push([id, ref]);
    },
    store: new InMemoryMockStore(),
  };
  return { d, calls };
}

const cand = (id: string, ageMs: number, ref: string | null = `make:${id}`): RecoveryCandidate => ({
  id,
  createdAt: ago(ageMs),
  providerPaymentId: ref,
  idempotencyKey: `package:u1:${id}`,
});

test("חלון הזמן: 2 דקות עד 48 שעות, והסריקה מוגבלת", async () => {
  const { d, calls } = deps([]);
  await runPaymentRecovery({ provider: provider(), now: NOW, limit: 7, deps: d });
  assert.equal(calls.list[0].from.getTime(), NOW.getTime() - RECOVERY_MAX_AGE_MS);
  assert.equal(calls.list[0].to.getTime(), NOW.getTime() - RECOVERY_MIN_AGE_MS);
  assert.equal(calls.list[0].take, 35);
});

test("השהיה גדלה עם הגיל: רבע מהגיל, בין 5 דקות ל-6 שעות", () => {
  assert.equal(recheckIntervalMs(3 * MIN), 5 * MIN);
  assert.equal(recheckIntervalMs(60 * MIN), 15 * MIN);
  assert.equal(recheckIntervalMs(8 * 60 * MIN), 2 * 60 * MIN);
  assert.equal(recheckIntervalMs(40 * 60 * MIN), 6 * 60 * MIN);
});

test("כל בדיקה עוברת דרך finalize; תשלום שנבדק לא נבדק שוב לפני שעבר זמן ההשהיה", async () => {
  const { d, calls } = deps([cand("a", 60 * MIN)], async () => ({ outcome: "PACKAGE_ACTIVATED" }));
  const first = await runPaymentRecovery({ provider: provider(), now: NOW, deps: d });
  assert.deepEqual(calls.finalized, ["a"]);
  assert.deepEqual(first.outcomes, { PACKAGE_ACTIVATED: 1 });

  // 10 דקות אחר כך (השהיה לגיל ~70 דקות היא ~17 דקות): מדלגים
  const later = new Date(NOW.getTime() + 10 * MIN);
  const second = await runPaymentRecovery({ provider: provider(), now: later, deps: d });
  assert.equal(second.checked, 0);
  assert.equal(second.skippedBackoff, 1);
  assert.equal(calls.finalized.length, 1);

  // 20 דקות אחרי הבדיקה הראשונה: נבדק שוב
  const third = await runPaymentRecovery({ provider: provider(), now: new Date(NOW.getTime() + 20 * MIN), deps: d });
  assert.equal(third.checked, 1);
  assert.equal(calls.finalized.length, 2);
});

test("אימות לא זמין (Make/Grow): נספר כזמני, ונכנס להשהיה כמו בדיקה רגילה; שגיאה אחרת נספרת בנפרד", async () => {
  const { d, calls } = deps([cand("t", 30 * MIN), cand("e", 30 * MIN)], async (id) => {
    if (id === "t") throw new PaymentError("Make timeout");
    throw new PaymentStateError("state");
  });
  const s = await runPaymentRecovery({ provider: provider(), now: NOW, deps: d });
  assert.equal(s.transientFailures, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.checked, 2);
  const again = await runPaymentRecovery({ provider: provider(), now: new Date(NOW.getTime() + MIN), deps: d });
  assert.equal(again.checked, 0);
  assert.equal(calls.finalized.length, 2);
});

test("בלי מזהה ספק: לעולם לא נוצרת בקשה חדשה; משחזרים רק בקשה קיימת שהספק מוצא בלי רשת", async () => {
  // ספק בלי חיפוש: מדלגים, בלי finalize ובלי createPaymentRequest (שהיה זורק)
  let r = deps([cand("x", 30 * MIN, null)]);
  let s = await runPaymentRecovery({ provider: provider(), now: NOW, deps: r.d });
  assert.equal(s.skippedNoRef, 1);
  assert.deepEqual(r.calls.finalized, []);

  // ספק שלא מוצא בקשה קיימת: אותו דבר
  r = deps([cand("y", 30 * MIN, null)]);
  s = await runPaymentRecovery({ provider: provider({ findExistingPaymentRequest: async () => null }), now: NOW, deps: r.d });
  assert.equal(s.skippedNoRef, 1);
  assert.deepEqual(r.calls.finalized, []);

  // ספק שמוצא בקשה קיימת: המזהה נשמר ואז finalize
  r = deps([cand("z", 30 * MIN, null)]);
  const found = { providerPaymentId: "make:" + "f".repeat(32), status: "PENDING" as const, checkoutUrl: "https://sandbox.grow.link/x" };
  s = await runPaymentRecovery({ provider: provider({ findExistingPaymentRequest: async (k) => (k === "package:u1:z" ? found : null) }), now: NOW, deps: r.d });
  assert.deepEqual(r.calls.attached, [["z", found.providerPaymentId]]);
  assert.deepEqual(r.calls.finalized, ["z"]);
  assert.equal(s.checked, 1);
});

test("מגבלת בדיקות לריצה: לא יותר מ-limit פניות לספק", async () => {
  const many = Array.from({ length: 12 }, (_, i) => cand(`p${i}`, 30 * MIN));
  const { d, calls } = deps(many);
  const s = await runPaymentRecovery({ provider: provider(), now: NOW, limit: 5, deps: d });
  assert.equal(s.checked, 5);
  assert.equal(calls.finalized.length, 5);
  assert.equal(s.scanned, 12);
});

test("שורת הלוג כוללת מספרים בלבד", () => {
  const line = recoveryLogLine({ scanned: 3, checked: 2, skippedBackoff: 1, skippedNoRef: 0, outcomes: { PENDING: 1, PACKAGE_ACTIVATED: 1 }, transientFailures: 0, errors: 0 }, 812.4);
  assert.equal(line, "[payments] recovery scanned=3 checked=2 backoff=1 noRef=0 transient=0 errors=0 outcomes=PACKAGE_ACTIVATED:1,PENDING:1 ms=812");
});

test("Make: findExistingPaymentRequest מחזיר את הבקשה שנוצרה, ואינו פונה ל-Make בשום מצב", async () => {
  let calls = 0;
  const db = { user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: null }) } } as unknown as PrismaClient;
  const p = new MakeGrowPaymentProvider({
    webhookUrl: "https://hook.eu1.make.com/create",
    apiKey: "k".repeat(32),
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.link"],
    db,
    store: new InMemoryMockStore(),
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ url: "https://sandbox.grow.link/abc", processId: "1", processToken: "t" }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const created = await p.createPaymentRequest({ amountAgorot: 30000, currency: "ILS", description: "x", idempotencyKey: "package:u1:k1", customerRef: "u1", metadata: { packageHours: "5" } });
  assert.equal(calls, 1);
  assert.deepEqual(await p.findExistingPaymentRequest("package:u1:k1"), created);
  assert.equal(await p.findExistingPaymentRequest("package:u1:never"), null);
  assert.equal(await p.findExistingPaymentRequest(""), null);
  assert.equal(calls, 1);
});
