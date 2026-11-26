import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { InMemoryMockStore, type MockStore } from "@/lib/payments/mock-store";
import {
  IdempotencyConflictError,
  PaymentStateError,
  WebhookVerificationError,
  type CreatePaymentRequestInput,
  type PaymentProvider,
  type PaymentRequestResult,
  type PaymentWebhookEvent,
  type ProviderPaymentStatus,
  type RefundInput,
  type RefundResult,
  type VerifiedPaymentStatus,
  type WebhookInput,
} from "@/lib/payments/provider";

/**
 * ספק מדומה לבדיקות אוטומטיות בלבד. אינו זמין לאתר: config.ts אינו מכיר אותו, ואין דרך להפעיל אותו דרך משתני סביבה.
 * קוד אפליקטיבי לעולם לא מייבא את הקובץ הזה; רק קבצי *.test.ts.
 *
 * מדמה את מחזור החיים של תשלום בדף מתארח (כמו Grow): יצירה, השלמה בעמוד הספק (completeCheckout), webhook חתום,
 * שליפת סטטוס והחזרים, כדי לבדוק את הלוגיקה שלנו (מניעת חיוב כפול, אישור רק אחרי אימות, החזרים) בלי כסף אמיתי ובלי
 * חיבור חיצוני. אין בו כרטיס שמור או חיוב טוקן, כמו באתר עצמו.
 */

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

interface MockPayment {
  providerPaymentId: string;
  amountAgorot: number;
  status: ProviderPaymentStatus;
  refundedAgorot: number;
  failureCode?: string;
}

interface IdempotencyEntry {
  fingerprint: string;
  paymentId: string;
}

interface RefundEntry {
  result: RefundResult;
  fingerprint: string;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly environment = "sandbox" as const;

  constructor(
    private readonly webhookSecret: string,
    private readonly store: MockStore = new InMemoryMockStore()
  ) {}

  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestResult> {
    assertPositiveAmount(input.amountAgorot);
    const fingerprint = JSON.stringify([input.amountAgorot, input.currency, input.customerRef]);
    const idemKey = `idem:${input.idempotencyKey}`;

    const existing = await this.store.get<IdempotencyEntry>(idemKey);
    if (existing) return this.resumeRequest(existing, fingerprint);

    const payment: MockPayment = {
      providerPaymentId: `mock_pay_${randomUUID()}`,
      amountAgorot: input.amountAgorot,
      status: "PENDING",
      refundedAgorot: 0,
    };
    // קודם תופסים את מפתח ה-idempotency ורק אחר כך כותבים את התשלום, כדי שבקשות מקבילות לא ייצרו תשלומים יתומים
    const won = await this.store.putIfAbsent<IdempotencyEntry>(idemKey, { fingerprint, paymentId: payment.providerPaymentId });
    if (!won) {
      // בקשה מקבילה עם אותו מפתח הקדימה אותנו: מחזירים את התשלום שלה
      return this.resumeRequest((await this.store.get<IdempotencyEntry>(idemKey))!, fingerprint);
    }
    await this.store.put(`pay:${payment.providerPaymentId}`, payment);
    return this.toRequestResult(payment);
  }

  async getPaymentStatus(providerPaymentId: string): Promise<VerifiedPaymentStatus> {
    const p = await this.mustGet(providerPaymentId);
    return {
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      amountAgorot: p.amountAgorot,
      refundedAgorot: p.refundedAgorot,
      failureCode: p.failureCode,
    };
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    const p = await this.mustGet(providerPaymentId);
    if (p.status === "CANCELLED") return; // idempotent
    if (p.status !== "PENDING") {
      throw new PaymentStateError("ניתן לבטל רק תשלום שממתין להשלמה (אחרי הצלחה משתמשים בהחזר)");
    }
    p.status = "CANCELLED";
    await this.store.put(`pay:${p.providerPaymentId}`, p);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const fingerprint = JSON.stringify([input.providerPaymentId, input.amountAgorot ?? null]);
    const refundKey = `refund:${input.idempotencyKey}`;
    const prior = await this.store.get<RefundEntry>(refundKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("מפתח idempotency כבר שימש להחזר עם פרמטרים שונים");
      }
      return prior.result;
    }

    const p = await this.mustGet(input.providerPaymentId);
    if (p.status !== "SUCCEEDED") throw new PaymentStateError("ניתן להחזיר רק תשלום שהצליח");
    const remaining = p.amountAgorot - p.refundedAgorot;
    const amount = input.amountAgorot ?? remaining;
    assertPositiveAmount(amount);
    if (amount > remaining) throw new PaymentStateError("סכום ההחזר גדול מהיתרה הניתנת להחזר");

    p.refundedAgorot += amount;
    await this.store.put(`pay:${p.providerPaymentId}`, p);
    const result: RefundResult = { providerRefundId: `mock_ref_${randomUUID()}`, status: "SUCCEEDED", amountAgorot: amount };
    await this.store.put<RefundEntry>(refundKey, { result, fingerprint });
    return result;
  }

  async parseWebhook(input: WebhookInput): Promise<PaymentWebhookEvent> {
    const signature = input.headers[MOCK_SIGNATURE_HEADER];
    if (!signature || !signaturesMatch(signature, this.sign(input.rawBody))) {
      throw new WebhookVerificationError("חתימת webhook לא תקינה");
    }
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      throw new WebhookVerificationError("גוף webhook לא תקין");
    }
    const event = body as Partial<PaymentWebhookEvent>;
    if (
      typeof event.eventId !== "string" ||
      typeof event.providerPaymentId !== "string" ||
      (event.type !== "payment.updated" && event.type !== "refund.updated")
    ) {
      throw new WebhookVerificationError("מבנה webhook לא תקין");
    }
    return { eventId: event.eventId, type: event.type, providerPaymentId: event.providerPaymentId };
  }

  // ---- כלי בדיקה ----

  /** מדמה את הלקוח שסיים את עמוד התשלום המאובטח של הספק */
  async completeCheckout(providerPaymentId: string, outcome: "success" | "failure"): Promise<void> {
    const p = await this.mustGet(providerPaymentId);
    if (p.status !== "PENDING") throw new PaymentStateError("התשלום כבר הסתיים");
    if (outcome === "failure") {
      p.status = "FAILED";
      p.failureCode = "card_declined";
    } else {
      p.status = "SUCCEEDED";
    }
    await this.store.put(`pay:${p.providerPaymentId}`, p);
  }

  /** בונה גוף וכותרות של webhook חתום, כפי שספק היה שולח */
  buildWebhook(event: PaymentWebhookEvent): WebhookInput {
    const rawBody = JSON.stringify(event);
    return { rawBody, headers: { [MOCK_SIGNATURE_HEADER]: this.sign(rawBody) } };
  }

  private sign(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }

  private async mustGet(id: string): Promise<MockPayment> {
    // הזוכה במפתח idempotency עשוי עוד לא לסיים לכתוב את התשלום: ממתינים קצרות לפני שמדווחים שאינו קיים
    for (let attempt = 0; attempt < 20; attempt++) {
      const p = await this.store.get<MockPayment>(`pay:${id}`);
      if (p) return p;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new PaymentStateError("תשלום לא נמצא");
  }

  private async resumeRequest(entry: IdempotencyEntry, fingerprint: string): Promise<PaymentRequestResult> {
    if (entry.fingerprint !== fingerprint) {
      throw new IdempotencyConflictError("מפתח idempotency כבר שימש לבקשה עם פרמטרים שונים");
    }
    return this.toRequestResult(await this.mustGet(entry.paymentId));
  }

  private toRequestResult(p: MockPayment): PaymentRequestResult {
    return {
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      // כתובת סימבולית בלבד: אין עמוד תשלום אמיתי ואין קליטת פרטי כרטיס
      checkoutUrl: `mock://checkout/${p.providerPaymentId}`,
    };
  }
}

function assertPositiveAmount(amountAgorot: number) {
  if (!Number.isInteger(amountAgorot) || amountAgorot <= 0) {
    throw new PaymentStateError("הסכום חייב להיות מספר שלם חיובי של אגורות");
  }
}

function signaturesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
