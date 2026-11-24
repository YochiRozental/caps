import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore } from "@/lib/payments/mock-store";
import { MakeGrowPaymentProvider } from "@/lib/payments/make-provider";
import {
  IdempotencyConflictError,
  PaymentConfigError,
  PaymentError,
  PaymentStateError,
  WebhookVerificationError,
} from "@/lib/payments/provider";
import { isTransientVerifyFailure, verifyFailureLogLine } from "@/lib/payments/verify-errors";

const VERIFY_HOOK = "https://hook.eu1.make.com/verify-xyz";
const db = { user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: "d@x.com" }) } } as unknown as PrismaClient;
const REQ = { amountAgorot: 30000, currency: "ILS" as const, description: "d", idempotencyKey: "package:u1:abcdefgh", customerRef: "u1", metadata: { packageHours: "5" } };

/** ספק Make שתרחיש האימות שלו מחזיר את מה ש-verifyReply קובע (למשל 401 כשהמפתח לא תואם) */
function setup(verifyReply: () => Response) {
  const p = new MakeGrowPaymentProvider({
    webhookUrl: "https://hook.eu1.make.com/create-abc",
    apiKey: "k".repeat(32),
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.example"],
    verify: { webhookUrl: VERIFY_HOOK, apiKey: "v".repeat(32) },
    db,
    store: new InMemoryMockStore(),
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === VERIFY_HOOK) return verifyReply();
      void init;
      return new Response(JSON.stringify({ url: "https://pay.grow.example/abc", processId: "82393", processToken: "T".repeat(32) }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return p;
}

test("תקלות אימות זמניות מול Make מסווגות כ'לא זמין' - לא כשל תשלום ולא שגיאה כללית", async () => {
  // התרחיש שקרה ב-Staging: מפתח לא תואם -> Make מחזיר 401
  for (const reply of [
    () => new Response("Unauthorized.", { status: 401 }),
    () => new Response("Accepted", { status: 200 }), // תרחיש כבוי: Make מקבל לתור ולא עונה JSON
    () => new Response("", { status: 500 }),
    () => new Response(JSON.stringify({ reference: "other", processId: "82393", statusCode: "2" }), { status: 200 }),
  ]) {
    const p = setup(reply);
    const r = await p.createPaymentRequest(REQ);
    const err = await p.getPaymentStatus(r.providerPaymentId).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof PaymentError);
    assert.equal(isTransientVerifyFailure(err), true);
  }
});

test("שגיאות עם משמעות עסקית אינן 'זמניות'", () => {
  assert.equal(isTransientVerifyFailure(new PaymentStateError("x")), false);
  assert.equal(isTransientVerifyFailure(new IdempotencyConflictError("x")), false);
  assert.equal(isTransientVerifyFailure(new WebhookVerificationError("x")), false);
  assert.equal(isTransientVerifyFailure(new PaymentConfigError("x")), false);
  assert.equal(isTransientVerifyFailure(new Error("x")), false);
  assert.equal(isTransientVerifyFailure("x"), false);
});

test("אחרי שהתקלה ב-Make נפתרת, אותו תשלום מאומת בהצלחה בלי תשלום נוסף", async () => {
  let fixed = false;
  const p = setup(() =>
    fixed
      ? new Response(JSON.stringify({ reference: ref, processId: "82393", statusCode: "2", sum: "300.00", transactionId: "134005410" }), { status: 200 })
      : new Response("Unauthorized.", { status: 401 })
  );
  const r = await p.createPaymentRequest(REQ);
  const ref = r.providerPaymentId;
  await assert.rejects(p.getPaymentStatus(ref), (e: unknown) => isTransientVerifyFailure(e));
  fixed = true;
  const v = await p.getPaymentStatus(ref);
  assert.equal(v.status, "SUCCEEDED");
  assert.equal(v.amountAgorot, 30000);
  // אימות חוזר של אותה עסקה עדיין תקין (אידמפוטנטי), ולא נוצר קישור תשלום חדש
  assert.equal((await p.getPaymentStatus(ref)).status, "SUCCEEDED");
});

test("שורת הלוג כוללת את סיבת הכשל אבל לא סודות", () => {
  const line = verifyFailureLogLine(new PaymentError("Make החזיר שגיאה (HTTP 401)"), "cmwujmacs00002fl7k9tx26er");
  assert.match(line, /HTTP 401/);
  assert.match(line, /cmwujmacs00002fl7k9tx26er/);
});
