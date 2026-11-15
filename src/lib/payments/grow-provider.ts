import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { InMemoryMockStore, PrismaMockStore, type MockStore } from "@/lib/payments/mock-store";
import {
  PaymentError,
  PaymentStateError,
  WebhookVerificationError,
  type ChargeResult,
  type ChargeSavedMethodInput,
  type CreatePaymentRequestInput,
  type PaymentEnvironment,
  type PaymentProvider,
  type PaymentRequestResult,
  type PaymentWebhookEvent,
  type ProviderPaymentStatus,
  type RefundInput,
  type RefundResult,
  type SavedPaymentMethod,
  type VerifiedPaymentStatus,
  type WebhookInput,
} from "@/lib/payments/provider";

/**
 * ספק סליקה אמיתי מול Grow (Meshulam). מבוסס רק על מה שמאומת בתיעוד הרשמי (https://developers.grow.business/),
 * כולל: regular-payment-response, parameter-mapping, refund-overview, response-get-payment-info. כל מקום שעדיין
 * לא מתועד מסומן "לא מאומת" ומטופל בצד הבטוח (לעולם לא הצלחה/החזר שלא אומת, לעולם לא חיוב כפול עיוור).
 *
 * שלב זה: Sandbox בלבד. אין כאן קריאות אמיתיות ל-Production, ואין שינוי לברירת המחדל של ספק התשלומים.
 *
 * processId/processToken (providerPaymentId המקודד) הם מידע פנימי בין השרת שלנו לבין Grow - לפי regular-payment-response
 * ("processId and processToken must not be shown to the paying customer") הם לעולם לא נחשפים ללקוח. חשוב: קוד
 * קורא חייב להימנע מהחזרת providerPaymentId בתשובת API ללקוח (ראו תיקון ב-API routes, לא בקובץ הזה).
 *
 * זרימה מתארחת (הזמנה/חבילה, createPaymentRequest):
 *   createPaymentProcess -> data.url (עמוד תשלום) -> הלקוח משלים -> התראת Grow ל-notifyUrl (parseWebhook) ->
 *   approveTransaction (שלב נדרש בתיעוד, לעולם לא לחיובי טוקן, ומדולג באופן אידמפוטנטי על כפילות) -> אימות סטטוס
 *   מהשרת (getPaymentStatus, דרך getPaymentProcessInfo).
 *
 * חיוב טוקן (3 חיובי משמרת, chargeSavedMethod): קריאה סינכרונית ל-createTransactionWithToken. אין webhook
 * ואין approveTransaction (התיעוד לא מתאר approveTransaction עבור חיובי טוקן, ולפי ההנחיה אין לבצעו שם).
 */

// ───────────────────────────── קודי סטטוס (parameter-mapping, מאומת) ─────────────────────────────
// Grow יכול להחזיר אותם כמספר או כמחרוזת (לא מתועד באיזה פורמט בכל נקודת קצה) - משווים תמיד אחרי String().
const STATUS_NOT_PAID = "0";
const STATUS_PAID = "2";
const STATUS_CANCELLED_BEFORE_TRANSMISSION = "4";
/** שורת "עסקה" שהיא בעצמה רישום של החזר (לא הסטטוס של החיוב המקורי) - ראו שימוש ב-refundedAgorot */
const STATUS_REFUND_ENTRY = "6";
const STATUS_DENIED = "9";
const CHARGE_STATUS_CODES = new Set([STATUS_NOT_PAID, STATUS_PAID, STATUS_CANCELLED_BEFORE_TRANSMISSION, STATUS_DENIED]);

function statusCodeOf(t: Record<string, unknown> | undefined): string {
  return String(t?.statusCode ?? "");
}

// ───────────────────────────── קידוד מזהה הספק שלנו (providerPaymentId) ─────────────────────────────
// הממשק הקיים מגדיר providerPaymentId כמחרוזת אחת, אבל Grow מזהה תהליך/עסקה בזוג (מזהה+טוקן). מקודדים את
// השניים למחרוזת אחת, שקופה ללוגיקה העסקית (שם ולעולם לא מפרקת אותה - נבדק בקוד הקיים). "prc" נושא גם דגל הסכמה
// לשמירת כרטיס (מה שבאמת התבקש ב-createPaymentRequest), כדי ש-getPaymentStatus לעולם לא יחשוף טוקן בלי הסכמה.
type GrowRefKind = "prc" | "tx" | "fail";

function encodeRef(kind: GrowRefKind, id: string, token: string, extra?: string): string {
  const parts = ["grow", kind, encodeURIComponent(id), encodeURIComponent(token)];
  if (extra !== undefined) parts.push(encodeURIComponent(extra));
  return parts.join(":");
}

function decodeRef(ref: string): { kind: GrowRefKind; id: string; token: string; extra?: string } {
  const parts = ref.split(":");
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== "grow" || !["prc", "tx", "fail"].includes(parts[1])) {
    throw new PaymentError("מזהה תשלום של Grow לא תקין");
  }
  return {
    kind: parts[1] as GrowRefKind,
    id: decodeURIComponent(parts[2]),
    token: decodeURIComponent(parts[3]),
    extra: parts[4] !== undefined ? decodeURIComponent(parts[4]) : undefined,
  };
}

// ───────────────────────────── סכומים: אגורות (שלמות, המערכת שלנו) <-> שקלים (Grow) ─────────────────────────────

function assertPositiveAmount(amountAgorot: number) {
  if (!Number.isInteger(amountAgorot) || amountAgorot <= 0) {
    throw new PaymentError("הסכום חייב להיות מספר שלם חיובי של אגורות");
  }
}

/** אגורות שלמות -> מחרוזת שקלים בשתי ספרות אחרי הנקודה, כפי שמופיע בכל דוגמאות התיעוד (למשל "10.99") */
export function agorotToShekels(amountAgorot: number): string {
  assertPositiveAmount(amountAgorot);
  return (amountAgorot / 100).toFixed(2);
}

/** שקלים (כפי שמוחזר משדה sum של Grow) -> אגורות שלמות. מחזיר 0 אם השדה חסר/לא תקין (לעולם לא מנחש סכום) */
export function shekelsToAgorot(sum: unknown): number {
  const n = typeof sum === "number" ? sum : typeof sum === "string" ? Number(sum) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// ───────────────────────────── מזהה ייחודי מספרי לכל בקשה (transactionUniqueIdentifier) ─────────────────────────────
// Grow דורש מזהה *מספרי* למניעת כפילות (תיעוד: createTransactionWithToken, getTokenTransactionsByExternalIdentifiers),
// בזמן שמפתחות ה-idempotency שלנו הם מחרוזות (לדוגמה "shiftcharge:abc:2026-02:a1"). הגזירה כאן היא קביעה שלנו
// (לא מתועדת ב-Grow): hash דטרמיניסטי ל-9 ספרות, כך שאותו מפתח idempotency מניב תמיד את אותו מזהה אצל Grow.
export function deriveUniqueIdentifier(idempotencyKey: string): number {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12);
  return Number(BigInt(`0x${hex}`) % BigInt(1_000_000_000));
}

// ───────────────────────────── עזרי תשובה: המעטפת {status, err, data} ─────────────────────────────

interface GrowEnvelope {
  status?: string | number;
  err?: string | { id?: string | number; message?: string } | "";
  data?: unknown;
}

function envelopeOk(e: GrowEnvelope): boolean {
  return String(e.status) === "1";
}

function envelopeErrorMessage(e: GrowEnvelope): string {
  if (!e.err) return "unknown_error";
  if (typeof e.err === "string") return e.err || "unknown_error";
  return `${e.err.id ?? "?"}:${e.err.message ?? "unknown"}`;
}

function pickString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** MMYY (כפי שמתואר בדוגמאות cardExp) -> MM/YY. אם לא במבנה הצפוי מוחזר undefined (לעולם לא מומצא) */
function formatExpiry(cardExp: string | undefined): string | undefined {
  if (!cardExp || !/^\d{4}$/.test(cardExp)) return undefined;
  return `${cardExp.slice(0, 2)}/${cardExp.slice(2)}`;
}

/** paymentDate בפורמט DD/MM/YY (כפי שבדוגמאות approve-transaction/getTransactionInfo) מול תאריך השרת, כמחרוזת בלבד */
function isSameDay(paymentDateDDMMYY: string | undefined, now: Date): boolean {
  if (!paymentDateDDMMYY || !/^\d{2}\/\d{2}\/\d{2}$/.test(paymentDateDDMMYY)) return false; // לא ניתן לקבוע - לא חוסמים בניחוש
  const today = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getFullYear() % 100).padStart(2, "0")}`;
  return paymentDateDDMMYY === today;
}

// ───────────────────────────── מספר טלפון ושם מלא (Grow דורש אותם בכל קריאה; הממשק שלנו מכוון שלא לשאת PII) ─────────────────────────────

/** 05XXXXXXXX. תומך בקידומת 972/+972 ומנקה רווחים/מקפים. זורק אם לא ניתן לנרמל - לא שולחים ל-Grow ערך לא תקין */
export function normalizeIsraeliPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  const local = digits.startsWith("972") ? `0${digits.slice(3)}` : digits.startsWith("0") ? digits : digits ? `0${digits}` : "";
  if (!/^0\d{8,9}$/.test(local)) {
    throw new PaymentError("לא ניתן לחייב/לתשלום מול Grow בלי מספר טלפון תקין של הלקוח");
  }
  return local;
}

/** Grow: "pageField[fullName] must include at least two names" */
export function assertFullName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.split(/\s+/).filter(Boolean).length < 2) {
    throw new PaymentError("לא ניתן לחייב/לתשלום מול Grow בלי שם מלא (שם ושם משפחה) של הלקוח");
  }
  return trimmed;
}

// ───────────────────────────── תצורה ─────────────────────────────

export const GROW_SANDBOX_BASE_URL = "https://sandbox.meshulam.co.il/api/light/server/1.0/";

export interface GrowConfig {
  userId: string;
  pageCode: string;
  /** כתובת הבסיס של ה-API, עם '/' בסוף. Sandbox: GROW_SANDBOX_BASE_URL. Production: לא מתועד כקבוע - מגיע ב-env */
  apiBaseUrl: string;
  environment: PaymentEnvironment;
  /** עמוד הצלחה/ביטול: Grow מחייב HTTPS, לא localhost. הממשק הקיים לא מעביר אותם per-request, אז הם קבועים בתצורה */
  successUrl: string;
  cancelUrl: string;
  /** אופציונלי: התיעוד לא מבטיח שזה המנגנון היחיד לקבלת webhooks (לעיתים נדרשת הרשמה ידנית מול התמיכה) */
  notifyUrl?: string;
  db?: PrismaClient;
  /**
   * אחסון idempotency עמיד (שורד הפעלה מחדש/מופע אחר). ברירת מחדל: טבלת MockProviderRecord הקיימת
   * (PrismaMockStore, src/lib/payments/mock-store.ts) - key-value גנרי, בלי מיגרציה. השם "Mock" בתוכה היסטורי;
   * שימוש בה כאן לנתוני Grow אמיתיים הוא בכוונה כדי לא לדרוש מיגרציה חדשה בשלב Sandbox הזה - מומלץ טבלה/שם
   * ייעודיים בהמשך (דורש מיגרציה ואישור, לא בוצע כאן).
   */
  store?: MockStore;
  /** נקודת הזרקה לבדיקות בלבד */
  fetchImpl?: typeof fetch;
}

interface GrowCreateClaim {
  fingerprint: string;
  /** null = עדיין בעבודה (תפיסה פעילה) או ננטשה (claimedAt=0) */
  result: PaymentRequestResult | null;
  claimedAt: number;
}

/** כמה זמן בקשה שהפסידה במרוץ ה-idempotency מוכנה להמתין לתוצאת הזוכה, לפני שהיא מדווחת "נסו שוב" */
const GROW_CREATE_WAIT_TOTAL_MS = 8_000;
const GROW_CREATE_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GrowPaymentProvider implements PaymentProvider {
  readonly name = "grow";
  readonly environment: PaymentEnvironment;
  private readonly db: PrismaClient;
  private readonly fetchImpl: typeof fetch;
  private readonly store: MockStore;

  constructor(private readonly cfg: GrowConfig) {
    this.environment = cfg.environment;
    this.db = cfg.db ?? defaultDb;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.store = cfg.store ?? new PrismaMockStore(this.db);
  }

  // ---- HTTP ----

  private async call(path: string, params: Record<string, string | number | undefined>): Promise<GrowEnvelope> {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.append(key, String(value));
    }
    const url = `${this.cfg.apiBaseUrl}${path}`;
    let res: Response;
    try {
      // שרת-לשרת בלבד (דרישת Grow בכל נקודות הקצה) - אסור לקרוא מצד הלקוח
      res = await this.fetchImpl(url, { method: "POST", body: form });
    } catch (err) {
      throw new PaymentError(`תקשורת עם Grow נכשלה (${path}): ${err instanceof Error ? err.message : "unknown"}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PaymentError(`תשובת Grow לא תקינה (${path}, HTTP ${res.status})`);
    }
    return (json ?? {}) as GrowEnvelope;
  }

  private async resolveCustomer(customerRef: string): Promise<{ fullName: string; phone: string; email?: string }> {
    const user = await this.db.user.findUnique({ where: { id: customerRef }, select: { name: true, phone: true, email: true } });
    if (!user) throw new PaymentError("לקוח לא נמצא - לא ניתן לחייב מול Grow");
    return { fullName: assertFullName(user.name), phone: normalizeIsraeliPhone(user.phone), email: user.email ?? undefined };
  }

  // ---- PaymentProvider ----

  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestResult> {
    assertPositiveAmount(input.amountAgorot);
    const fingerprint = JSON.stringify([input.amountAgorot, input.currency, input.customerRef, !!input.savePaymentMethod]);
    const idemKey = `grow-create:${input.idempotencyKey}`;

    // פער מאומת: createPaymentProcess (בניגוד ל-createTransactionWithToken) לא מתועד עם פרמטר idempotency כלשהו,
    // אז מבטיחים זאת בעצמנו. התפיסה (putIfAbsent) היא INSERT אטומי מול PostgreSQL (MockProviderRecord.key הוא
    // @id ייחודי) - לכן בטוחה גם בין בקשות מקבילות וגם בין מופעי שרת שונים, לא רק בתוך תהליך Node אחד. רק הצד
    // שמנצח בתפיסה פונה בפועל ל-Grow; המפסיד ממתין קצרות לתוצאתו, ולעולם לא יוצר תהליך Grow שני בעצמו.
    const claimed = await this.store.putIfAbsent<GrowCreateClaim>(idemKey, { fingerprint, result: null, claimedAt: Date.now() });
    if (!claimed) return this.awaitExistingCreate(idemKey, fingerprint);

    try {
      const result = await this.doCreatePaymentProcess(input);
      await this.store.put<GrowCreateClaim>(idemKey, { fingerprint, result, claimedAt: Date.now() });
      return result;
    } catch (err) {
      // נכשלנו אחרי שתפסנו את המפתח: מסמנים "ננטש" (claimedAt=0) כדי שניסיון חוזר עם אותו מפתח ידע שאין תוצאה
      // ממתינה ולא יתקע לנצח - אבל לא מנחשים/משלימים תוצאה בעצמנו (ראו awaitExistingCreate: תפיסה ננטשת נדרשת
      // בבירור מפורש, לא תפיסה-מחדש אוטומטית, כי אין במנגנון הזה נעילה אטומית ל"תפיסה מחדש" בלי לדעת אם הבקשה
      // הקודמת בכל זאת הגיעה ל-Grow).
      await this.store.put<GrowCreateClaim>(idemKey, { fingerprint, result: null, claimedAt: 0 }).catch(() => {});
      throw err;
    }
  }

  private async doCreatePaymentProcess(input: CreatePaymentRequestInput): Promise<PaymentRequestResult> {
    const customer = await this.resolveCustomer(input.customerRef);
    const resp = await this.call("createPaymentProcess", {
      pageCode: this.cfg.pageCode,
      userId: this.cfg.userId,
      chargeType: 1,
      sum: agorotToShekels(input.amountAgorot),
      successUrl: input.returnUrl ?? this.cfg.successUrl,
      cancelUrl: this.cfg.cancelUrl,
      description: input.description,
      "pageField[fullName]": customer.fullName,
      "pageField[phone]": customer.phone,
      "pageField[email]": customer.email,
      saveCardToken: input.savePaymentMethod ? 1 : 0,
      notifyUrl: this.cfg.notifyUrl,
      cField1: input.idempotencyKey,
    });
    if (!envelopeOk(resp)) throw new PaymentError(`Grow: יצירת בקשת תשלום נכשלה (${envelopeErrorMessage(resp)})`);

    const data = resp.data;
    const processId = pickString(data, ["processId"]);
    const processToken = pickString(data, ["processToken"]);
    if (!processId || !processToken) {
      throw new PaymentError("תשובת Grow ל-createPaymentProcess לא כוללת processId/processToken");
    }
    // מאומת (regular-payment-response): קישור עמוד התשלום הוא data.url. אם חסר/לא תקין - שגיאה מבוקרת, לעולם לא
    // "הצלחה" בלי קישור שהלקוח יכול לשלם בו.
    const checkoutUrl = pickString(data, ["url"]);
    if (!checkoutUrl || !/^https?:\/\//i.test(checkoutUrl)) {
      throw new PaymentError("תשובת Grow ל-createPaymentProcess לא כללה קישור תשלום תקין (data.url)");
    }

    // processId/processToken: מידע פנימי בין השרת שלנו ל-Grow (regular-payment-response: "must not be shown to
    // the paying customer") - מקודדים יחד עם דגל הסכמת שמירת הכרטיס, כדי ש-getPaymentStatus יאכוף אותו בעצמו.
    return {
      providerPaymentId: encodeRef("prc", processId, processToken, input.savePaymentMethod ? "1" : "0"),
      status: "PENDING",
      checkoutUrl,
    };
  }

  /**
   * מחכה קצרות לתוצאה של בקשה שהקדימה אותנו באותו מפתח idempotency (ראו createPaymentRequest). תפיסה פעילה אך
   * עדיין בלי תוצאה = ממתינים; תפיסה "ננטשה" (claimedAt=0, כישלון ודאי בניסיון הקודם) נזרקת במפורש כדי שהקריאה
   * תטופל מחדש עם מפתח idempotency חדש - אין כאן תפיסה-מחדש אוטומטית, כדי לא ליצור תהליך Grow כפול במרוץ עם
   * בקשה אחרת שמנסה את אותו דבר. פתרון "תפיסה מחדש" בטוח ואוטומטי דורש נעילה/CAS אמיתי במסד (מיגרציה), לא בוצע כאן.
   */
  private async awaitExistingCreate(idemKey: string, fingerprint: string): Promise<PaymentRequestResult> {
    const deadline = Date.now() + GROW_CREATE_WAIT_TOTAL_MS;
    for (;;) {
      const existing = await this.store.get<GrowCreateClaim>(idemKey);
      if (existing && existing.fingerprint !== fingerprint) {
        throw new PaymentError("מפתח idempotency כבר שימש לבקשת תשלום אחרת ב-Grow");
      }
      if (existing?.result) return existing.result;
      if (existing && existing.claimedAt === 0) {
        throw new PaymentError("בקשת התשלום הקודמת עם מפתח idempotency זה נכשלה ומצבה מול Grow לא ידוע - יש לנסות שוב עם מפתח חדש אחרי בירור");
      }
      if (Date.now() >= deadline) {
        throw new PaymentError("בקשת תשלום מקבילה עם אותו מפתח עדיין בעיבוד - נסו שוב בעוד רגע");
      }
      await sleep(GROW_CREATE_POLL_INTERVAL_MS);
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<VerifiedPaymentStatus> {
    const ref = decodeRef(providerPaymentId);

    if (ref.kind === "fail") {
      // כישלון מקומי שכבר אומת מול Grow (תשובת שגיאה חד-משמעית בזמן החיוב) - אין צורך/אפשרות לשאול שוב
      return { providerPaymentId, status: "FAILED", amountAgorot: 0, refundedAgorot: 0, failureCode: ref.token || undefined };
    }

    if (ref.kind === "prc") {
      const resp = await this.call("getPaymentProcessInfo", { pageCode: this.cfg.pageCode, processId: ref.id, processToken: ref.token });
      if (!envelopeOk(resp)) throw new PaymentError(`Grow: בדיקת מצב תהליך התשלום נכשלה (${envelopeErrorMessage(resp)})`);
      // מאומת (response-get-payment-info): data.transactions הוא מערך; "6" הוא רישום של החזר, לא סטטוס החיוב עצמו
      const data = resp.data as { transactions?: Record<string, unknown>[] } | undefined;
      const transactions = Array.isArray(data?.transactions) ? data!.transactions : [];
      const chargeEntries = transactions.filter((t) => CHARGE_STATUS_CODES.has(statusCodeOf(t)));
      if (chargeEntries.length === 0) return { providerPaymentId, status: "PENDING", amountAgorot: 0, refundedAgorot: 0 };
      const chosen = chargeEntries.find((t) => statusCodeOf(t) === STATUS_PAID) ?? chargeEntries[chargeEntries.length - 1];
      const consentToSave = ref.extra === "1";
      const base = this.toVerifiedStatus(providerPaymentId, chosen, consentToSave);
      const refundedFromEntries = transactions
        .filter((t) => statusCodeOf(t) === STATUS_REFUND_ENTRY)
        .reduce((sum, r) => sum + shekelsToAgorot(r.sum), 0);
      return refundedFromEntries > 0 ? { ...base, refundedAgorot: refundedFromEntries } : base;
    }

    // ref.kind === "tx"
    const resp = await this.call("getTransactionInfo", { pageCode: this.cfg.pageCode, transactionId: ref.id, transactionToken: ref.token });
    if (!envelopeOk(resp)) throw new PaymentError(`Grow: בדיקת מצב עסקה נכשלה (${envelopeErrorMessage(resp)})`);
    return this.toVerifiedStatus(providerPaymentId, resp.data as Record<string, unknown> | undefined, false);
  }

  private toVerifiedStatus(providerPaymentId: string, d: Record<string, unknown> | undefined, consentToSave: boolean): VerifiedPaymentStatus {
    // מאומת (parameter-mapping): 0=לא שולם, 2=שולם, 4=בוטלה לפני שידור, 9=עסקה נדחתה. כל קוד אחר (לא מוכר) נשאר
    // PENDING בכוונה - חוסר ודאות לעולם לא מתפרש כהצלחה.
    const code = statusCodeOf(d);
    const status: ProviderPaymentStatus =
      code === STATUS_PAID
        ? "SUCCEEDED"
        : code === STATUS_DENIED
          ? "FAILED"
          : code === STATUS_CANCELLED_BEFORE_TRANSMISSION
            ? "CANCELLED"
            : "PENDING";
    const amountAgorot = shekelsToAgorot(d?.sum);
    // טוקן נחשף רק מעסקה ששולמה בפועל (לעולם לא מ-PENDING/DENIED) וכשההסכמה לשמירה ניתנה ביצירת הבקשה
    const cardToken = status === "SUCCEEDED" && consentToSave ? pickString(d, ["cardToken"]) : undefined;
    const savedPaymentMethod: SavedPaymentMethod | undefined = cardToken
      ? { token: cardToken, last4: pickString(d, ["cardSuffix"]), brand: pickString(d, ["cardBrand"]), expiry: formatExpiry(pickString(d, ["cardExp"])) }
      : undefined;
    // לא מאומת: ל-getTransactionInfo (ללא מערך transactions) אין שדה "סכום שהוחזר" מתועד. refundedTransactionId רק
    // מצביע שבוצע החזר כלשהו; מניחים החזר מלא כקירוב שמרני-יתר. (ה-branch "prc" מחשב סכום מדויק ממערך העסקאות).
    const refundedAgorot = d?.refundedTransactionId ? amountAgorot : 0;
    return { providerPaymentId, status, amountAgorot, refundedAgorot, savedPaymentMethod };
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    // ל-Grow אין API מתועד לבטל תהליך תשלום שעדיין לא הושלם - אם התהליך לא הושלם, אין מה לשלוח ל-Grow; הביטול
    // מתועד רק במסד שלנו. אם בכל זאת הושלם בהצלחה (מרוץ עם סגירת העמוד ע"י הלקוח) - זורקים, בדיוק כמו ה-Mock.
    const verified = await this.getPaymentStatus(providerPaymentId).catch(() => undefined);
    if (verified?.status === "SUCCEEDED") {
      throw new PaymentStateError("לא ניתן לבטל: התשלום כבר הושלם אצל Grow");
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const ref = decodeRef(input.providerPaymentId);
    if (ref.kind === "fail") throw new PaymentStateError("לא ניתן להחזיר תשלום שכשל אצל Grow");

    let transactionId: string;
    let transactionToken: string;
    let paymentDate: string | undefined;
    let fullSumAgorot: number;
    let priorRefundCount = 0;

    if (ref.kind === "tx") {
      transactionId = ref.id;
      transactionToken = ref.token;
      const info = await this.call("getTransactionInfo", { pageCode: this.cfg.pageCode, transactionId, transactionToken });
      if (!envelopeOk(info)) throw new PaymentError(`Grow: לא ניתן לאתר את העסקה להחזר (${envelopeErrorMessage(info)})`);
      const d = info.data as Record<string, unknown> | undefined;
      paymentDate = pickString(d, ["paymentDate"]);
      fullSumAgorot = shekelsToAgorot(d?.sum);
    } else {
      const status = await this.call("getPaymentProcessInfo", { pageCode: this.cfg.pageCode, processId: ref.id, processToken: ref.token });
      if (!envelopeOk(status)) throw new PaymentError(`Grow: לא ניתן לאתר את העסקה להחזר (${envelopeErrorMessage(status)})`);
      const data = status.data as { transactions?: Record<string, unknown>[] } | undefined;
      const txs = Array.isArray(data?.transactions) ? data!.transactions : [];
      const paid = txs.find((t) => statusCodeOf(t) === STATUS_PAID);
      if (!paid) throw new PaymentStateError("לא נמצאה עסקה ששולמה בתהליך זה - אין מה להחזיר");
      const txId = pickString(paid, ["transactionId"]);
      const txToken = pickString(paid, ["transactionToken"]);
      if (!txId || !txToken) throw new PaymentError("תשובת Grow לא כללה מזהה עסקה להחזר");
      transactionId = txId;
      transactionToken = txToken;
      paymentDate = pickString(paid, ["paymentDate"]);
      fullSumAgorot = shekelsToAgorot(paid.sum);
      priorRefundCount = txs.filter((t) => statusCodeOf(t) === STATUS_REFUND_ENTRY).length;
    }

    const amountAgorot = input.amountAgorot ?? Math.max(0, fullSumAgorot);
    assertPositiveAmount(amountAgorot);

    // מאומת (refund-overview): עסקה מאותו יום מתבטלת בלבד (הכול-או-כלום); לא ניתן להחזיר ממנה סכום חלקי
    if (isSameDay(paymentDate, new Date()) && amountAgorot < fullSumAgorot) {
      throw new PaymentStateError("לא ניתן להחזיר סכום חלקי מעסקה שבוצעה היום לפי Grow - יש לבטל את הסכום המלא, או להמתין ליום הבא");
    }
    // מאומת (refund-overview): עד שני החזרים דרך ה-API לכל עסקה; מהשלישי יש לפנות לשירות הלקוחות של Grow
    if (priorRefundCount >= 2) {
      throw new PaymentStateError("הושגה המגבלה של שני החזרים דרך ה-API לעסקה זו - החזר נוסף דורש פנייה לתמיכת Grow");
    }

    const resp = await this.call("refundTransaction", {
      transactionId,
      transactionToken,
      userId: this.cfg.userId,
      pageCode: this.cfg.pageCode,
      refundSum: agorotToShekels(amountAgorot),
    });
    if (!envelopeOk(resp)) throw new PaymentStateError(`Grow: ההחזר נדחה (${envelopeErrorMessage(resp)})`);
    const data = resp.data;
    return {
      providerRefundId: pickString(data, ["refundedTransactionId"]) ?? `grow_refund_${transactionId}_${Date.now()}`,
      status: "SUCCEEDED",
      amountAgorot,
    };
  }

  async chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeResult> {
    assertPositiveAmount(input.amountAgorot);
    const customer = await this.resolveCustomer(input.customerRef);
    const uniqueId = deriveUniqueIdentifier(input.idempotencyKey);

    // בדיקה מקדימה אצל Grow: אם ניסיון קודם עם אותו מזהה ייחודי כבר התבצע (למשל כשל רשת אצלנו אחרי שהחיוב כבר
    // הגיע ל-Grow), Grow דוחה מזהה חזור כשגיאה ולא מחזיר את התוצאה המקורית (מאומת בתיעוד ה-changelog) - אז בודקים
    // ראשית כדי למנוע גם את השגיאה וגם חיוב כפול.
    const prior = await this.lookupTokenChargeByUniqueIdentifier(input.token, uniqueId);
    if (prior) return prior;

    const resp = await this.call("createTransactionWithToken", {
      cardToken: input.token,
      userId: this.cfg.userId,
      sum: agorotToShekels(input.amountAgorot),
      description: input.description,
      paymentType: 2, // "רגיל": כל חיוב (משמרת/הזמנה) הוא עסקה עצמאית, לא הוראת קבע מנוהלת ע"י Grow
      "pageField[fullName]": customer.fullName,
      "pageField[phone]": customer.phone,
      transactionUniqueIdentifier: uniqueId,
    });

    if (!envelopeOk(resp)) {
      const failureCode = envelopeErrorMessage(resp);
      // תשובת שגיאה חד-משמעית מ-Grow (status=0+err) - כישלון ודאי, לא UNKNOWN. אין מזהה עסקה אצל Grow לשמור
      return { providerPaymentId: encodeRef("fail", uniqueId.toString(), failureCode), status: "FAILED", failureCode };
    }
    const data = resp.data;
    const transactionId = pickString(data, ["transactionId"]);
    const transactionToken = pickString(data, ["transactionToken"]);
    if (!transactionId || !transactionToken) {
      // מאומת (token-transactions-response): תשובת הצלחה כוללת תמיד transactionId/transactionToken - אם הם חסרים
      // בכל זאת, לא מניחים הצלחה ולא ממציאים מזהה
      throw new PaymentError("תשובת Grow ל-createTransactionWithToken לא כללה מזהה עסקה אף ש-status=1");
    }
    // מאומת (token-transactions-response): הצלחה תמיד מגיעה עם statusCode=2 ("שולם"). אם statusCode קיים ושונה
    // מזה (סתירה בין status=1 לרמת המעטפת לבין statusCode ברמת הנתונים) - לא מאשרים אוטומטית, נדרש בירור.
    const code = statusCodeOf(data as Record<string, unknown>);
    if (code && code !== STATUS_PAID) {
      throw new PaymentError(`Grow: status=1 אך statusCode=${code} (לא "שולם") - מצב לא עקבי, נדרש בירור ולא הצלחה אוטומטית`);
    }
    return { providerPaymentId: encodeRef("tx", transactionId, transactionToken), status: "SUCCEEDED" };
  }

  /** עוזר לבירור חיובים במצב לא ידוע ולמניעת חיוב כפול (לא חלק מחוזה PaymentProvider; לשימוש עתידי/בירור ידני) */
  async lookupTokenChargeByUniqueIdentifier(cardToken: string, uniqueId: number): Promise<ChargeResult | null> {
    const resp = await this.call("getTokenTransactionsByExternalIdentifiers", {
      userId: this.cfg.userId,
      cardToken,
      transactionUniqueIdentifier: uniqueId,
    }).catch(() => undefined);
    if (!resp || !envelopeOk(resp)) return null;
    // מבנה התשובה לא מתועד; מתמודדים גם עם data כאובייקט עסקה בודד וגם עם data.transactions[] כמו בשאר הנקודות
    const data = resp.data as { transactions?: unknown[] } | Record<string, unknown> | undefined;
    const candidate = Array.isArray((data as { transactions?: unknown[] })?.transactions)
      ? (data as { transactions: Record<string, unknown>[] }).transactions[0]
      : (data as Record<string, unknown> | undefined);
    const transactionId = pickString(candidate, ["transactionId"]);
    const transactionToken = pickString(candidate, ["transactionToken"]);
    if (!transactionId || !transactionToken) return null;
    const status: ProviderPaymentStatus = statusCodeOf(candidate) === STATUS_PAID ? "SUCCEEDED" : "PENDING";
    return { providerPaymentId: encodeRef("tx", transactionId, transactionToken), status };
  }

  async isPaymentMethodUsable(_token: string): Promise<boolean> {
    // Grow לא מתעד API לבדיקת תקינות טוקן בלי חיוב בפועל - שמישות מתגלה רק בניסיון חיוב (ChargeResult.status)
    return true;
  }

  async parseWebhook(input: WebhookInput): Promise<PaymentWebhookEvent> {
    const data = parseGrowCallbackPayload(input.rawBody);
    const processId = pickString(data, ["processId"]);
    const processToken = pickString(data, ["processToken"]);
    const transactionId = pickString(data, ["transactionId"]);
    if (!processId || !processToken || !transactionId) {
      throw new WebhookVerificationError("מבנה התראת Grow לא תקין או חלקי (שדות מזהים חסרים)");
    }

    // אישור עסקה בצד השרת, לפי תיעוד Grow (the-process). אינו חוסם: "transaction still processed if this call
    // is skipped or fails". מדולג אידמפוטנטית אם ההתראה הזו (אותה transactionId) טופלה כבר - מונע אישור כפול כש-Grow
    // שולח את אותה התראה פעמיים (retry של webhook). לעולם לא לחיובי טוקן - אלה לא עוברים דרך webhook/parseWebhook.
    await this.approveTransactionBestEffort(data);

    const statusCode = statusCodeOf(data);
    return { eventId: `${transactionId}:${statusCode}`, type: "payment.updated", providerPaymentId: encodeRef("prc", processId, processToken) };
  }

  private async approveTransactionBestEffort(data: Record<string, unknown>): Promise<void> {
    const required = [
      "transactionId", "transactionToken", "transactionTypeId", "paymentType", "sum", "firstPaymentSum",
      "periodicalPaymentSum", "paymentsNum", "allPaymentsNum", "paymentDate", "asmachta", "description",
      "fullName", "payerPhone", "payerEmail", "cardSuffix", "cardType", "cardTypeCode", "cardBrand",
      "cardBrandCode", "cardExp", "processId", "processToken",
    ] as const;
    if (required.some((k) => data[k] === undefined || data[k] === null || data[k] === "")) {
      // לא מאומת שכל השדות (לדוגמה asmachta) נמצאים בכל התראה בפועל - מדלגים בלי לנחש ערך חסר
      return;
    }
    // דה-דופליקציה עמידה (שורדת הפעלה מחדש) לפי transactionId - מונעת אישור כפול כש-webhook מגיע יותר מפעם אחת.
    // קריטי: מסמנים "אושר" רק אחרי תשובת הצלחה מאומתת (envelopeOk) מ-Grow עצמו. כישלון זמני (תקשורת, status=0)
    // *לעולם* לא נרשם כאישור מוצלח - כך שניסיון חוזר (webhook נוסף, או הרצה עתידית) עדיין ינסה שוב, ולא יידמה
    // שהאישור כבר בוצע כשלמעשה הוא לא אומת.
    const dedupeKey = `grow-approved:${String(data.transactionId)}`;
    const alreadyConfirmed = await this.store.get<boolean>(dedupeKey).catch(() => undefined);
    if (alreadyConfirmed === true) return;
    try {
      const resp = await this.call("approveTransaction", {
        pageCode: this.cfg.pageCode,
        ...Object.fromEntries(required.map((k) => [k, data[k] as string | number])),
      });
      if (envelopeOk(resp)) {
        await this.store.put(dedupeKey, true).catch(() => {});
      }
      // status=0: לא נרשם כהצלחה. לפי התיעוד אי-ביצוע/כשל של approveTransaction לא חוסם את התשלום עצמו,
      // אז לא זורקים - אך גם לא מניחים הצלחה שלא אומתה
    } catch {
      // כשל תקשורת - לא נרשם כהצלחה, בדיוק מאותה סיבה
    }
  }
}

/**
 * גוף התראת ה-notifyUrl. התיעוד סותר את עצמו (מתואר כ-form-encoded, אך הדוגמה מוצגת כ-JSON מקונן
 * {status,err,data:{...}}) - מתמודדים עם שתי האפשרויות: JSON תקין, או form-urlencoded עם שדות שטוחים.
 * מחזיר את תוכן ה-data בלבד (לא מאמת סטטוס HTTP-level נוסף; parseWebhook בודק את השדות הדרושים לו עצמו).
 */
function parseGrowCallbackPayload(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as GrowEnvelope;
    if (parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object") {
      return parsed.data as Record<string, unknown>;
    }
  } catch {
    // לא JSON - ממשיכים לניסיון form-urlencoded
  }
  try {
    const flat = Object.fromEntries(new URLSearchParams(rawBody));
    if (Object.keys(flat).length > 0) return flat;
  } catch {
    // ignore
  }
  throw new WebhookVerificationError("לא ניתן לפענח את גוף התראת Grow");
}

// ייצוא לבדיקות בלבד (לא חלק מחוזה הספק): מאפשר לבדיקות יחידה להשתמש באחסון בזיכרון בלי מסד נתונים אמיתי
export { InMemoryMockStore };
