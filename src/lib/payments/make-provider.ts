import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { agorotToShekels, assertFullName, normalizeIsraeliPhone } from "@/lib/payments/grow-provider";
import { PrismaMockStore, type MockStore } from "@/lib/payments/mock-store";
import {
  PaymentError,
  WebhookVerificationError,
  type ChargeResult,
  type CreatePaymentRequestInput,
  type PaymentEnvironment,
  type PaymentProvider,
  type PaymentRequestResult,
  type PaymentWebhookEvent,
  type RefundResult,
  type VerifiedPaymentStatus,
} from "@/lib/payments/provider";

/**
 * ספק סליקה "הקפסולה -> Make -> Grow Sandbox". רכיב נפרד מ-GrowPaymentProvider (שלא נגעים בו): כאן Grow נקרא רק
 * דרך תרחיש Make (Webhook עם x-make-apikey -> Grow "Create Payment Link" -> Webhook response עם הקישור).
 *
 * מה שמומש: יצירת קישור תשלום בלבד. כל השאר נכשל במפורש ובמכוון (ללא מעקף ל-Grow ישיר):
 *  - getPaymentStatus: אין עדיין מבנה תשובה מאומת של "Get Payment Link Info" דרך Make, לכן לעולם לא מחזירים
 *    SUCCEEDED (או כל סטטוס) בלי אימות אמיתי. הודעת הצלחה מהדפדפן/Notify URL אינה הוכחת תשלום.
 *  - parseWebhook: אין עדיין חתימה/סוד מאומתים להתראות נכנסות.
 *  - refund / chargeSavedMethod / cancelPayment / שמירת כרטיס: אין תרחיש Make מתאים.
 * הספק חסום להפעלה דרך PAYMENT_PROVIDER כל עוד MAKE_PROVIDER_VERIFICATION_READY=false (ראו config.ts).
 */
export const MAKE_PROVIDER_VERIFICATION_READY = false;

export const MAKE_API_KEY_HEADER = "x-make-apikey";
export const MIN_MAKE_API_KEY_LENGTH = 24;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const WAIT_TOTAL_MS = 8_000;
const WAIT_POLL_MS = 250;

export interface MakeConfig {
  /** כתובת ה-Custom webhook בתרחיש (HTTPS בלבד). סוד: לא נרשם בלוגים ולא נחשף ללקוח */
  webhookUrl: string;
  apiKey: string;
  environment: PaymentEnvironment;
  /**
   * דומיינים מאושרים לקישור התשלום (התאמה למארח עצמו או לתת-דומיין שלו). חובה ולא ריק: אין ברירת מחדל, כי דומייני
   * ה-checkout של Grow לא מאומתים בתיעוד שנבדק - מגדירים אותם במפורש אחרי שרואים את הקישור האמיתי ב-Sandbox
   */
  allowedCheckoutHosts: string[];
  db?: PrismaClient;
  /** אחסון idempotency עמיד. ברירת מחדל: PrismaMockStore (אותה טבלה כמו ב-Grow, ללא מיגרציה) */
  store?: MockStore;
  timeoutMs?: number;
  /** הזרקה לבדיקות בלבד */
  fetchImpl?: typeof fetch;
}

type ClaimState = "pending" | "done" | "unknown";

interface MakeCreateClaim {
  fingerprint: string;
  state: ClaimState;
  result: PaymentRequestResult | null;
}

/** רשומה שרתית בלבד (לא חוזרת ללקוח): מזהי Grow אופציונליים כפי שחזרו מ-Make */
interface MakePaymentRecord {
  checkoutUrl: string;
  processId?: string;
  processToken?: string;
  createdAt: number;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** מזהה תשלום דטרמיניסטי מתוך מפתח ה-idempotency: אותו מפתח -> אותו מזהה, בלי תלות בתשובת Make */
export function deriveMakePaymentId(idempotencyKey: string): string {
  return `make:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

/** קישור תשלום תקין: HTTPS, בלי פרטי גישה מוטמעים, בלי מארח מקומי/IP פנימי. זה כל מה שמאומת לגבי הקישור */
export function parseCheckoutUrl(value: unknown, allowedHosts: readonly string[]): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new PaymentError("תשובת Make לא כללה קישור תשלום");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentError("קישור התשלום שהתקבל מ-Make אינו כתובת תקינה");
  }
  const host = url.hostname.toLowerCase();
  const isLocal = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
  const isIp = /^[\d.]+$/.test(host) || host.includes(":");
  if (url.protocol !== "https:" || url.username || url.password || isLocal || isIp) {
    throw new PaymentError("קישור התשלום שהתקבל מ-Make אינו HTTPS תקין");
  }
  if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new PaymentError("קישור התשלום שהתקבל מ-Make אינו בדומיין מאושר");
  }
  return url.toString();
}

/** שם מארח בלבד, באותיות קטנות, עם נקודה אחת לפחות (למשל "example.co.il"): לא סכמה, נתיב, פורט או תו כללי */
export function isValidAllowedHost(host: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host);
}

/** רשימה מופרדת בפסיקים (מ-env) -> שמות מארח מנורמלים. ערך לא תקין נשאר ברשימה ונדחה בבנאי */
export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

export class MakeGrowPaymentProvider implements PaymentProvider {
  readonly name = "make-grow";
  readonly environment: PaymentEnvironment;
  private readonly db: PrismaClient;
  private readonly fetchImpl: typeof fetch;
  private readonly store: MockStore;

  constructor(private readonly cfg: MakeConfig) {
    if (cfg.environment !== "sandbox") throw new PaymentError("ספק Make נתמך בשלב זה ב-sandbox בלבד");
    if (new URL(cfg.webhookUrl).protocol !== "https:") throw new PaymentError("כתובת ה-Webhook של Make חייבת להיות HTTPS");
    if (!cfg.apiKey || cfg.apiKey.length < MIN_MAKE_API_KEY_LENGTH) {
      throw new PaymentError(`מפתח ה-API של Make קצר מ-${MIN_MAKE_API_KEY_LENGTH} תווים`);
    }
    if (cfg.allowedCheckoutHosts.length === 0 || !cfg.allowedCheckoutHosts.every(isValidAllowedHost)) {
      throw new PaymentError("חובה להגדיר דומייני checkout מאושרים (שמות מארח תקינים, בלי סכמה או תווים כלליים)");
    }
    this.environment = cfg.environment;
    this.db = cfg.db ?? defaultDb;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.store = cfg.store ?? new PrismaMockStore(this.db);
  }

  private async resolveCustomer(customerRef: string): Promise<{ fullName: string; phone: string; email?: string }> {
    const user = await this.db.user.findUnique({ where: { id: customerRef }, select: { name: true, phone: true, email: true } });
    if (!user) throw new PaymentError("לקוח לא נמצא - לא ניתן ליצור קישור תשלום");
    return { fullName: assertFullName(user.name), phone: normalizeIsraeliPhone(user.phone), email: user.email ?? undefined };
  }

  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestResult> {
    if (!Number.isInteger(input.amountAgorot) || input.amountAgorot <= 0) {
      throw new PaymentError("הסכום חייב להיות מספר שלם חיובי של אגורות");
    }
    if (input.currency !== "ILS") throw new PaymentError("רק ILS נתמך");
    if (input.savePaymentMethod) throw new PaymentError("שמירת אמצעי תשלום אינה נתמכת דרך Make");
    if (!input.idempotencyKey) throw new PaymentError("חסר מפתח idempotency");

    const fingerprint = JSON.stringify([input.amountAgorot, input.currency, input.customerRef]);
    const claimKey = `make-create:${input.idempotencyKey}`;

    // כל הוולידציה ופתרון הלקוח לפני התפיסה: כשל כאן ודאי שלא שלח דבר ל-Make, ולכן לא נשאר "סימן" שחוסם ניסיון חוזר
    const customer = await this.resolveCustomer(input.customerRef);
    const providerPaymentId = deriveMakePaymentId(input.idempotencyKey);

    // תפיסה אטומית (INSERT ייחודי): רק המנצח פונה ל-Make; מפסיד ממתין לתוצאתו ולעולם לא יוצר קישור שני
    const claimed = await this.store.putIfAbsent<MakeCreateClaim>(claimKey, { fingerprint, state: "pending", result: null });
    if (!claimed) return this.awaitExisting(claimKey, fingerprint, providerPaymentId);

    try {
      // מכאן הבקשה עלולה להגיע ל-Make וליצור קישור ב-Grow גם אם לא קיבלנו תשובה תקינה. גם תשובת 4xx/5xx אינה הוכחה
      // שלא נוצר קישור (תרחיש יכול להחזיר כל סטטוס אחרי שכבר פנה ל-Grow), ולכן כל כשל כאן = "לא ידוע", בלי ניסיון חוזר
      const data = await this.postToMake({
        reference: providerPaymentId,
        idempotencyKey: input.idempotencyKey,
        amount: agorotToShekels(input.amountAgorot),
        currency: input.currency,
        description: input.description,
        purpose: input.metadata?.packageHours ? "PACKAGE" : input.metadata?.appointmentId ? "BOOKING" : "OTHER",
        fullName: customer.fullName,
        phone: customer.phone,
        email: customer.email,
        returnUrl: input.returnUrl,
      });
      const checkoutUrl = parseCheckoutUrl(data.url, this.cfg.allowedCheckoutHosts);
      const record: MakePaymentRecord = {
        checkoutUrl,
        processId: optionalString(data.processId),
        processToken: optionalString(data.processToken),
        createdAt: Date.now(),
      };
      await this.store.put<MakePaymentRecord>(`make-payment:${providerPaymentId}`, record);
      const result: PaymentRequestResult = { providerPaymentId, status: "PENDING", checkoutUrl };
      await this.store.put<MakeCreateClaim>(claimKey, { fingerprint, state: "done", result });
      return result;
    } catch (err) {
      await this.store.put<MakeCreateClaim>(claimKey, { fingerprint, state: "unknown", result: null }).catch(() => {});
      throw err;
    }
  }

  private async postToMake(payload: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [MAKE_API_KEY_HEADER]: this.cfg.apiKey },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      // ההודעה לא כוללת את הכתובת או את המפתח (סודות)
      throw new PaymentError("תקשורת עם Make נכשלה או חרגה מהזמן - מצב הקישור לא ידוע");
    }
    if (!res.ok) throw new PaymentError(`Make החזיר שגיאה (HTTP ${res.status})`);
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new PaymentError("תשובת Make לא נקראה");
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new PaymentError("תשובת Make גדולה מדי");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PaymentError("תשובת Make אינה JSON תקין");
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new PaymentError("תשובת Make אינה אובייקט");
    return json as Record<string, unknown>;
  }

  private async awaitExisting(claimKey: string, fingerprint: string, providerPaymentId: string): Promise<PaymentRequestResult> {
    const deadline = Date.now() + WAIT_TOTAL_MS;
    for (;;) {
      const existing = await this.store.get<MakeCreateClaim>(claimKey);
      if (existing && existing.fingerprint !== fingerprint) {
        throw new PaymentError("מפתח idempotency כבר שימש לבקשת תשלום אחרת");
      }
      if (existing?.state === "done" && existing.result) return existing.result;
      if (existing && existing.state !== "done") {
        // התאוששות עקבית: אם הרשומה השרתית נשמרה (למשל עדכון התפיסה נכשל אחרי שהקישור כבר התקבל) - מחזירים אותה
        const record = await this.store.get<MakePaymentRecord>(`make-payment:${providerPaymentId}`);
        if (record?.checkoutUrl) return { providerPaymentId, status: "PENDING", checkoutUrl: record.checkoutUrl };
      }
      if (existing?.state === "unknown") {
        throw new PaymentError("מצב בקשת התשלום הקודמת מול Make לא ידוע (ייתכן שנוצר קישור) - נדרש בירור ידני לפני ניסיון חוזר");
      }
      if (Date.now() >= deadline) throw new PaymentError("בקשת תשלום מקבילה עם אותו מפתח עדיין בעיבוד - נסו שוב בעוד רגע");
      await sleep(WAIT_POLL_MS);
    }
  }

  // ---- יכולות שלא נתמכות עדיין: נכשלות במפורש, בלי מעקף ל-Grow ישיר ----

  async getPaymentStatus(): Promise<VerifiedPaymentStatus> {
    throw new PaymentError("אימות סטטוס תשלום דרך Make טרם מומש - אין אימות אמיתי, לכן לא מוחזר סטטוס");
  }

  async cancelPayment(): Promise<void> {
    throw new PaymentError("ביטול תשלום אינו נתמך דרך Make");
  }

  async refund(): Promise<RefundResult> {
    throw new PaymentError("החזר אינו נתמך דרך Make");
  }

  async chargeSavedMethod(): Promise<ChargeResult> {
    throw new PaymentError("חיוב אמצעי תשלום שמור אינו נתמך דרך Make");
  }

  async parseWebhook(): Promise<PaymentWebhookEvent> {
    throw new WebhookVerificationError("קליטת התראות דרך Make טרם מומשה - אין אימות חתימה");
  }
}
