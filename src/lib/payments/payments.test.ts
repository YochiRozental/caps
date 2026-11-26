import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPaymentProvider } from "@/lib/payments/testing/mock-provider";
import { getPaymentProvider, type PaymentEnv } from "@/lib/payments/config";
import {
  IdempotencyConflictError,
  PaymentConfigError,
  PaymentStateError,
  WebhookVerificationError,
} from "@/lib/payments/provider";

const SECRET = "test-webhook-secret-0123456789";

function makeProvider() {
  return new MockPaymentProvider(SECRET);
}

const baseRequest = {
  amountAgorot: 5200,
  currency: "ILS" as const,
  description: "test",
  customerRef: "user-1",
};

test("payment lifecycle: success is only visible via server-side status", async () => {
  const p = makeProvider();
  const created = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  assert.equal(created.status, "PENDING");
  assert.equal((await p.getPaymentStatus(created.providerPaymentId)).status, "PENDING");

  await p.completeCheckout(created.providerPaymentId, "success");
  const status = await p.getPaymentStatus(created.providerPaymentId);
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.amountAgorot, 5200);
});

test("failed payment", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.completeCheckout(providerPaymentId, "failure");
  const status = await p.getPaymentStatus(providerPaymentId);
  assert.equal(status.status, "FAILED");
  assert.ok(status.failureCode);
  await assert.rejects(() => p.refund({ providerPaymentId, idempotencyKey: "r1" }), PaymentStateError);
});

test("idempotency: same key returns the same payment, different params conflict", async () => {
  const p = makeProvider();
  const a = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "same" });
  const b = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "same" });
  assert.equal(a.providerPaymentId, b.providerPaymentId);
  await assert.rejects(
    () => p.createPaymentRequest({ ...baseRequest, amountAgorot: 9999, idempotencyKey: "same" }),
    IdempotencyConflictError
  );
});

test("cancel: pending only, repeat is a no-op", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.cancelPayment(providerPaymentId);
  await p.cancelPayment(providerPaymentId);
  assert.equal((await p.getPaymentStatus(providerPaymentId)).status, "CANCELLED");

  const paid = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k2" });
  await p.completeCheckout(paid.providerPaymentId, "success");
  await assert.rejects(() => p.cancelPayment(paid.providerPaymentId), PaymentStateError);
});

test("partial and full refunds, never above the paid amount, idempotent", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.completeCheckout(providerPaymentId, "success");

  const r1 = await p.refund({ providerPaymentId, amountAgorot: 2000, idempotencyKey: "r1" });
  assert.equal(r1.amountAgorot, 2000);
  const r1again = await p.refund({ providerPaymentId, amountAgorot: 2000, idempotencyKey: "r1" });
  assert.equal(r1again.providerRefundId, r1.providerRefundId);
  assert.equal((await p.getPaymentStatus(providerPaymentId)).refundedAgorot, 2000);

  await assert.rejects(
    () => p.refund({ providerPaymentId, amountAgorot: 3201, idempotencyKey: "r2" }),
    PaymentStateError
  );
  await assert.rejects(
    () => p.refund({ providerPaymentId, amountAgorot: 1, idempotencyKey: "r1" }),
    IdempotencyConflictError
  );

  const rest = await p.refund({ providerPaymentId, idempotencyKey: "r3" });
  assert.equal(rest.amountAgorot, 3200);
  assert.equal((await p.getPaymentStatus(providerPaymentId)).refundedAgorot, 5200);
});

test("תשלום שהושלם לא מחזיר אמצעי תשלום שמור או טוקן: אין כרטיס שמור במערכת", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.completeCheckout(providerPaymentId, "success");
  const status = await p.getPaymentStatus(providerPaymentId);
  assert.deepEqual(Object.keys(status).filter((k) => status[k as keyof typeof status] !== undefined).sort(), ["amountAgorot", "providerPaymentId", "refundedAgorot", "status"]);
});

test("amounts must be positive integers", async () => {
  const p = makeProvider();
  for (const amountAgorot of [0, -5, 10.5]) {
    await assert.rejects(() => p.createPaymentRequest({ ...baseRequest, amountAgorot, idempotencyKey: `k${amountAgorot}` }));
  }
});

test("webhook: valid signature accepted, tampering and missing signature rejected", async () => {
  const p = makeProvider();
  const event = { eventId: "evt_1", type: "payment.updated" as const, providerPaymentId: "mock_pay_x" };
  const signed = p.buildWebhook(event);
  assert.deepEqual(await p.parseWebhook(signed), event);

  await assert.rejects(
    () => p.parseWebhook({ ...signed, rawBody: signed.rawBody.replace("mock_pay_x", "mock_pay_y") }),
    WebhookVerificationError
  );
  await assert.rejects(() => p.parseWebhook({ rawBody: signed.rawBody, headers: {} }), WebhookVerificationError);

  const other = new MockPaymentProvider("another-secret-0123456789").buildWebhook(event);
  await assert.rejects(() => p.parseWebhook(other), WebhookVerificationError);
});

// ---- אין ספק מדומה באתר: רק Grow / Make ----

test("mock אינו ספק מוכר באתר, גם עם כל הדגלים שפעם התירו אותו", () => {
  const legacyMockEnv = {
    NODE_ENV: "development",
    PAYMENT_PROVIDER: "mock",
    PAYMENT_ENVIRONMENT: "sandbox",
    PAYMENT_MOCK_ENABLED: "true",
    PAYMENT_MOCK_ALLOW_DEPLOYED: "true",
    PAYMENT_MOCK_OPEN_TO_ALL: "true",
    PAYMENT_WEBHOOK_SECRET: SECRET,
    DATABASE_URL: "postgresql://u:p@localhost:5433/clinics_payments_dev",
  } as PaymentEnv;
  assert.throws(() => getPaymentProvider(legacyMockEnv), /לא מוכר/);
  assert.throws(() => getPaymentProvider({ ...legacyMockEnv, PAYMENT_PROVIDER: " MOCK " }), /לא מוכר/);
});

test("error messages never leak configured values", () => {
  try {
    getPaymentProvider({ PAYMENT_PROVIDER: "grow", PAYMENT_ENVIRONMENT: "live", GROW_USER_ID: "hunter2-user", GROW_PAGE_CODE: "secret-page" });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof PaymentConfigError);
    assert.ok(!err.message.includes("hunter2-user"));
    assert.ok(!err.message.includes("secret-page"));
  }
});

test("no provider configured and unknown provider names refuse", () => {
  assert.throws(() => getPaymentProvider({}), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "none" }), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "stripe" }), PaymentConfigError);
  // payme היה placeholder זמני ולא ממומש מעולם; הוחלף ב-grow (ראו grow-provider.ts) ואינו שם ספק מוכר יותר
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "payme" }), /לא מוכר/);
});

test("grow: חסום מחוץ ל-sandbox, ודורש משתני סביבה מפורשים (שלב Sandbox בלבד)", () => {
  const growEnv = {
    PAYMENT_PROVIDER: "grow",
    PAYMENT_ENVIRONMENT: "sandbox",
    GROW_USER_ID: "biz1",
    GROW_PAGE_CODE: "page1",
    GROW_SUCCESS_URL: "https://example.com/success",
    GROW_CANCEL_URL: "https://example.com/cancel",
  };
  assert.equal(getPaymentProvider(growEnv).name, "grow");
  assert.throws(() => getPaymentProvider({ ...growEnv, PAYMENT_ENVIRONMENT: "live" }), PaymentConfigError, "חסום ב-live בלי GROW_ALLOW_LIVE");
  assert.throws(() => getPaymentProvider({ ...growEnv, GROW_USER_ID: undefined }), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ ...growEnv, GROW_SUCCESS_URL: undefined }), PaymentConfigError);
});

