import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { agorotToShekels, assertFullName, normalizeIsraeliPhone, shekelsToAgorot } from "@/lib/payments/grow-provider";
import { PrismaMockStore, type MockStore } from "@/lib/payments/mock-store";
import { PACKAGE_RETURN_PATH } from "@/lib/payments/embedded-checkout";
import { timeStep } from "@/lib/payments/timing";
import {
  PaymentError,
  WebhookVerificationError,
  type CreatePaymentRequestInput,
  type PaymentEnvironment,
  type PaymentProvider,
  type PaymentRequestResult,
  type PaidTransaction,
  type PaymentWebhookEvent,
  type RefundResult,
  type VerifiedPaymentStatus,
  type WebhookInput,
} from "@/lib/payments/provider";

/**
 * ספק סליקה "הקפסולה -> Make -> Grow Sandbox". רכיב נפרד מ-GrowPaymentProvider (שלא נגעים בו): כאן Grow נקרא רק
 * דרך תרחיש Make (Webhook עם x-make-apikey -> Grow "Create Payment Link" -> Webhook response עם הקישור).
 *
 * מה שמומש: יצירת קישור תשלום בלבד. כל השאר נכשל במפורש ובמכוון (ללא מעקף ל-Grow ישיר):
 *  - getPaymentStatus: אין עדיין מבנה תשובה מאומת של "Get Payment Link Info" דרך Make, לכן לעולם לא מחזירים
 *    SUCCEEDED (או כל סטטוס) בלי אימות אמיתי. הודעת הצלחה מהדפדפן/Notify URL אינה הוכחת תשלום.
 *  - parseWebhook: התראת שרת מ-Grow לכתובת שהאתר חתם (HMAC), טריגר לאימות מחדש בלבד (ראו parseWebhook).
 *  - refund / cancelPayment: אין תרחיש Make מתאים. אין שמירת כרטיס או חיוב טוקן במערכת כלל.
 * הספק חסום להפעלה דרך PAYMENT_PROVIDER כל עוד MAKE_PROVIDER_VERIFICATION_READY=false (ראו config.ts).
 */
export const MAKE_PROVIDER_VERIFICATION_READY = false;

/**
 * הפעלה מפורשת של ספק Make ב-Staging בלבד, אחרי שתרחיש האימות (Get Payment Link Info) נבדק ידנית מול Grow Sandbox.
 * ברירת מחדל: חסום. הדגל לבדו אינו מספיק: config.ts דורש גם שער Staging פעיל ומארח Staging מוכר, כך שאי אפשר להפעיל ב-Production.
 */
export function isMakeVerificationReady(env: Record<string, string | undefined> = process.env): boolean {
  return MAKE_PROVIDER_VERIFICATION_READY || env.MAKE_VERIFICATION_CONFIRMED === "true";
}

export const MAKE_API_KEY_HEADER = "x-make-apikey";
export const MIN_MAKE_API_KEY_LENGTH = 24;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const WAIT_TOTAL_MS = 8_000;
const WAIT_POLL_MS = 250;

/**
 * מסלול יצירת דף התשלום ב-Grow:
 *  - "link": Create Payment Link (המסלול הקיים, ברירת המחדל). דף grow.link, שאינו מתיר הטמעה באתר שלנו.
 *  - "process": createPaymentProcess (Light API) דרך תרחיש Make נפרד. דף התשלום שלו מיועד גם ל-iframe.
 * כל תשלום זוכר באיזה מסלול נוצר (MakePaymentRecord.flow), והאימות שלו תמיד עובר דרך תרחיש האימות של אותו מסלול,
 * כך שמעבר בין המסלולים לא שובר תשלומים פתוחים.
 */
export type MakeCheckoutFlow = "link" | "process";

export interface MakeWebhookTarget {
  webhookUrl: string;
  apiKey: string;
}

export interface MakeConfig {
  /** כתובת ה-Custom webhook בתרחיש (HTTPS בלבד). סוד: לא נרשם בלוגים ולא נחשף ללקוח */
  webhookUrl: string;
  apiKey: string;
  /** המסלול לתשלומים חדשים. ברירת מחדל: "link" (ללא שינוי מהמצב הקיים) */
  flow?: MakeCheckoutFlow;
  /**
   * תרחישי Make של מסלול Payment Process (יצירה ואימות). אופציונלי: חובה רק כש-flow="process". כשהוא מוגדר גם במסלול
   * "link", תשלומי process שכבר נוצרו ממשיכים להתאמת אחרי חזרה למסלול הקישורים
   */
  process?: { create: MakeWebhookTarget; verify: MakeWebhookTarget };
  /** תרחיש האימות (Get Payment Link Info) - חובה כדי ש-getPaymentStatus יעבוד; בלעדיו האימות נכשל במפורש */
  verify?: { webhookUrl: string; apiKey: string };
  /** בסיס HTTPS של האתר לבניית כתובת החזרה אחרי תשלום (ההחזרה אינה הוכחת תשלום - האימות רק בשרת) */
  returnBaseUrl?: string;
  /**
   * תרחיש approveTransaction (אופציונלי). לפי Grow: האישור אינו משנה את סטטוס העסקה, ובלעדיו Grow שולח את ההתראה
   * שוב עד 5 פעמים. לכן הוא best-effort בלבד ואינו תנאי להפעלת חבילה
   */
  approve?: { webhookUrl: string; apiKey: string };
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
  /** המסלול שבו נוצר התשלום. חסר ברשומות ישנות = "link" */
  flow?: MakeCheckoutFlow;
  /** הסכום שביקשנו (אגורות): הסכום הצפוי לכל תשובת אימות שאינה "שולם" */
  amountAgorot: number;
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

// ───────────────────────────── התראת שרת מ-Grow (notifyUrl) ─────────────────────────────

/** נתיב ה-webhook של הספק באתר (src/app/api/payments/webhook/[provider]) */
export const MAKE_NOTIFY_PATH = "/api/payments/webhook/make-grow";
const PROVIDER_REF = /^make:[0-9a-f]{32}$/;

/**
 * חתימת כתובת ההתראה. Grow אינו חותם התראות (לפי התיעוד אין סוד/חתימה), ולכן האתר חותם בעצמו את הכתובת שהוא נותן
 * ל-Grow: HMAC על מזהה התשלום, במפתח שנגזר ממפתח ה-API של Make (קיים רק בשרת וב-Make). התראה בלי חתימה תקינה נדחית.
 * גם התראה חתומה היא טריגר בלבד: הסטטוס נשלף מחדש מ-Grow דרך תרחיש האימות לפני כל זיכוי.
 */
export function signNotifyRef(ref: string, apiKey: string): string {
  const key = createHash("sha256").update(`caps-grow-notify-v1:${apiKey}`).digest();
  return createHmac("sha256", key).update(ref).digest("hex");
}

export function verifyNotifySignature(ref: string, sig: string, apiKey: string): boolean {
  if (!PROVIDER_REF.test(ref) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(signNotifyRef(ref, apiKey), "hex"), Buffer.from(sig, "hex"));
}

/**
 * גוף התראת Grow: JSON ({data:{...}}) או POST של טופס, כולל מפתחות בסגנון data[transactionId] ו-
 * data[customFields][cField1]. מחזיר מילון שטוח (שם השדה הפנימי -> ערך). גוף שלא ניתן לפענח -> {} (לא זורקים:
 * הגוף אינו מקור אמת, רק בדיקת עקביות נוספת)
 */
export function flattenGrowNotifyBody(rawBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if ((typeof v === "string" || typeof v === "number") && String(v).length <= 512) out[k] = String(v);
  };
  const trimmed = rawBody.trim().slice(0, 64 * 1024);
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as { data?: Record<string, unknown> } & Record<string, unknown>;
      const data = json.data && typeof json.data === "object" ? json.data : json;
      for (const [k, v] of Object.entries(data)) {
        if (k === "customFields" && v && typeof v === "object") for (const [ck, cv] of Object.entries(v)) put(ck, cv);
        else put(k, v);
      }
      return out;
    } catch {
      return {};
    }
  }
  for (const [rawKey, v] of new URLSearchParams(trimmed)) {
    const m = /^(?:data\[)?([A-Za-z0-9_]+)\]?(?:\[([A-Za-z0-9_]+)\])?$/.exec(rawKey);
    if (!m) continue;
    put(m[1] === "customFields" && m[2] ? m[2] : m[1], v);
  }
  return out;
}

// ───────────────────────────── פענוח תשובת תרחיש האימות ─────────────────────────────

/** קודי סטטוס של Grow לעסקה (parameter-mapping): 2 = שולם, 6 = עסקת החזר. כל השאר (0, 4, 9...) = לא שולם */
const GROW_PAID = "2";
const GROW_REFUND = "6";
const MAX_TRANSACTIONS = 50;
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS_CODE = /^\d{1,2}$/;

export interface RefundTransaction {
  /** חסר כש-Grow לא החזיר מזהה לעסקת ההחזר */
  transactionId?: string;
  /** הסכום שהוחזר (ערך מוחלט, אגורות). 0 כשהסכום לא ידוע */
  amountAgorot: number;
}

export interface VerifyTransactionsView {
  /** "v2": כל העסקאות של הקישור, כל עסקה כאובייקט אחד; "legacy": עסקה אחת (התרחיש הישן) */
  format: "v2" | "legacy";
  /** קודי הסטטוס של כל העסקאות שהתרחיש ראה */
  statusCodes: string[];
  /** העסקאות ששולמו, ייחודיות לפי מזהה. הסכום והמזהה של כל פריט מגיעים מאותו אובייקט עסקה */
  paid: PaidTransaction[];
  /** עסקאות החזר (קוד 6). קיום של אחת מהן חוסם הפעלה אוטומטית */
  refunds: RefundTransaction[];
}

function malformed(detail: string): PaymentError {
  return new PaymentError(`תשובת האימות מ-Make אינה תקינה (${detail}) - לא מאושר`);
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim();
  return undefined;
}

/**
 * מפענח את תשובת תרחיש האימות. שני מבנים נתמכים, כדי שחזרה לתרחיש הישן תמיד תעבוד:
 *
 *  - v2 (format="v2"): התרחיש מחזיר את כל העסקאות של קישור התשלום כמערך JSON, כל עסקה כאובייקט אחד:
 *    grow.transactions = [{ statusCode, sum, transactionId, paymentLinkProcessId }]. השדות של עסקה נשארים יחד, כך
 *    שהסכום והמזהה תמיד שייכים לאותה עסקה. הבחירה נעשית כאן ולא בנוסחת Make.
 *    קשירה לנתון של Grow: paymentLinkProcessId של כל עסקה (מזהה קישור התשלום כפי ש-Grow מדווח עליו בעסקה עצמה)
 *    חייב להיות זהה למזהה שנשמר בשרת כשהקישור נוצר. בעסקה ששולמה ובעסקת החזר השדה חובה; בשאר, אם קיים - נבדק.
 *  - legacy (בלי format): statusCode / sum / transactionId של עסקה אחת, כפי שהתרחיש הישן מחזיר. אין בו קשירה לעסקה.
 *
 * תשובה לא תקינה זורקת PaymentError (כשל אימות זמני): שום מצב לא משתנה, והתשלום נשאר ממתין.
 */
export function parseVerifyTransactions(
  data: Record<string, unknown>,
  expectedProcessId: string,
  flow: MakeCheckoutFlow = "link"
): VerifyTransactionsView {
  // התשובה חייבת להצהיר על אותו מסלול שבו נוצר התשלום: תרחיש אימות של מסלול אחר (הגדרה שגויה) נדחה ואינו מאשר דבר.
  // במסלול process חובה v2 עם flow="process" (אין מבנה legacy שקושר עסקה לתהליך)
  if (flow === "process") {
    if (data.format !== "v2" || data.flow !== "process") throw malformed("תשובה שאינה של מסלול Payment Process");
  } else if (data.flow !== undefined && data.flow !== "link") {
    throw malformed("תשובה של מסלול אחר");
  }
  // השדה שקושר כל עסקה לתשלום שלנו: במסלול הקישורים - מזהה קישור התשלום; במסלול process - מזהה התהליך עצמו
  const bindingField = flow === "process" ? "processId" : "paymentLinkProcessId";
  if (data.format === "v2") {
    const grow = data.grow;
    if (!grow || typeof grow !== "object" || Array.isArray(grow)) throw malformed("grow חסר");
    const list = (grow as Record<string, unknown>).transactions;
    // מערך ריק = אין עסקאות. כש-Make לא מצא עסקאות השדה עשוי להיות חסר לגמרי
    const items = list === undefined || list === null ? [] : list;
    if (!Array.isArray(items)) throw malformed("transactions אינו מערך");
    if (items.length > MAX_TRANSACTIONS) throw malformed("יותר מדי עסקאות");
    // מסלול process: תרחיש האימות מעביר את data של getPaymentProcessInfo כפי שהוא. אם Grow מחזיר processId ברמת
    // התהליך, הוא חייב להיות התהליך השמור (אחרת שום עסקה לא נבדקת), ומשמש קשירה לעסקה שאין בה processId משלה.
    // עסקה שיש בה processId - נבדקת לפיו בלבד. אין processId בשום רמה בעסקה ששולמה -> נדחה (כשל סגור)
    let processLevelId = "";
    if (flow === "process") {
      processLevelId = scalar((grow as Record<string, unknown>).processId) ?? "";
      if (processLevelId && processLevelId !== expectedProcessId) throw malformed("תשובה של תהליך תשלום אחר");
    }

    const statusCodes: string[] = [];
    const paid = new Map<string, number>();
    const refunds: RefundTransaction[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw malformed("עסקה אינה אובייקט");
      const tx = item as Record<string, unknown>;
      const code = scalar(tx.statusCode) ?? "";
      if (!STATUS_CODE.test(code)) throw malformed("קוד סטטוס חסר או לא תקין");
      statusCodes.push(code);
      const linkId = scalar(tx[bindingField]) || processLevelId;
      const transactionId = scalar(tx.transactionId) ?? "";
      if (code === GROW_PAID || code === GROW_REFUND) {
        if (!linkId) throw malformed("עסקה ללא מזהה קישור התשלום של Grow");
      }
      if (linkId && linkId !== expectedProcessId) throw malformed("עסקה ששייכת לקישור תשלום אחר");
      if (transactionId && !TRANSACTION_ID.test(transactionId)) throw malformed("מזהה עסקה לא תקין");

      if (code === GROW_PAID) {
        const amountAgorot = shekelsToAgorot(scalar(tx.sum));
        if (!transactionId || amountAgorot <= 0) throw malformed("עסקה ששולמה ללא מזהה או סכום תקין");
        const seen = paid.get(transactionId);
        if (seen !== undefined && seen !== amountAgorot) throw malformed("אותה עסקה מופיעה בשני סכומים");
        paid.set(transactionId, amountAgorot);
      } else if (code === GROW_REFUND) {
        refunds.push({ transactionId: transactionId || undefined, amountAgorot: Math.abs(shekelsToAgorot(scalar(tx.sum))) });
      }
    }
    return {
      format: "v2",
      statusCodes,
      paid: [...paid].map(([transactionId, amountAgorot]) => ({ transactionId, amountAgorot })),
      refunds,
    };
  }

  const code = scalar(data.statusCode) ?? "";
  const legacy = (paid: PaidTransaction[], refunds: RefundTransaction[] = []): VerifyTransactionsView => ({
    format: "legacy",
    statusCodes: code ? [code] : [],
    paid,
    refunds,
  });
  const transactionId = scalar(data.transactionId) ?? "";
  if (code === GROW_REFUND) return legacy([], [{ transactionId: transactionId || undefined, amountAgorot: Math.abs(shekelsToAgorot(scalar(data.sum))) }]);
  if (code !== GROW_PAID) return legacy([]);
  const amountAgorot = shekelsToAgorot(data.sum);
  if (amountAgorot <= 0 || !transactionId) throw new PaymentError("תשובת אימות 'שולם' ללא סכום תקין או מזהה עסקה - לא מאושר");
  return legacy([{ transactionId, amountAgorot }]);
}


/**
 * תוצאת האימות מתוך העסקאות שפוענחו. פונקציה טהורה, משותפת לאימות האמיתי ולבדיקה היבשה.
 * אין עסקה ששולמה (רשימה ריקה, 0, 9, 4, 6 או קוד לא מוכר): ממתין - לעולם לא הצלחה ולעולם לא כישלון סופי.
 * החזר (6) מסומן ב-refundObserved. SUCCEEDED: הסכום של עסקה ששולמה (עדיפות לסכום הצפוי), וכל העסקאות ששולמו.
 */
export function verifiedStatusFromView(providerPaymentId: string, expectedAgorot: number, view: VerifyTransactionsView): VerifiedPaymentStatus {
  const refund =
    view.refunds.length > 0
      ? {
          refundObserved: true,
          refundTransactions: view.refunds.map((r, i) => ({ transactionId: r.transactionId ?? `refund-${i + 1}`, amountAgorot: r.amountAgorot })),
        }
      : {};
  const base = { providerPaymentId, refundedAgorot: view.refunds.reduce((sum, r) => sum + r.amountAgorot, 0), ...refund };
  if (view.paid.length === 0) return { ...base, status: "PENDING", amountAgorot: expectedAgorot };
  const chosen = view.paid.find((t) => t.amountAgorot === expectedAgorot) ?? view.paid[0];
  return { ...base, status: "SUCCEEDED", amountAgorot: chosen.amountAgorot, paidTransactions: view.paid };
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
    if (cfg.flow !== undefined && cfg.flow !== "link" && cfg.flow !== "process") throw new PaymentError("מסלול תשלום לא מוכר");
    if (cfg.flow === "process" && !cfg.process) throw new PaymentError("מסלול Payment Process דורש תרחישי יצירה ואימות ייעודיים");
    if (cfg.process) {
      for (const t of [cfg.process.create, cfg.process.verify]) {
        if (new URL(t.webhookUrl).protocol !== "https:") throw new PaymentError("כתובות ה-Webhook של מסלול Payment Process חייבות להיות HTTPS");
        if (!t.apiKey || t.apiKey.length < MIN_MAKE_API_KEY_LENGTH) {
          throw new PaymentError(`מפתח API של מסלול Payment Process קצר מ-${MIN_MAKE_API_KEY_LENGTH} תווים`);
        }
      }
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
    if (!input.idempotencyKey) throw new PaymentError("חסר מפתח idempotency");

    const fingerprint = JSON.stringify([input.amountAgorot, input.currency, input.customerRef]);
    const claimKey = `make-create:${input.idempotencyKey}`;

    // כל הוולידציה ופתרון הלקוח לפני התפיסה: כשל כאן ודאי שלא שלח דבר ל-Make, ולכן לא נשאר "סימן" שחוסם ניסיון חוזר
    const customer = await timeStep("make.customer", () => this.resolveCustomer(input.customerRef));
    const providerPaymentId = deriveMakePaymentId(input.idempotencyKey);
    const flow: MakeCheckoutFlow = this.cfg.flow ?? "link";

    // תפיסה אטומית (INSERT ייחודי): רק המנצח פונה ל-Make; מפסיד ממתין לתוצאתו ולעולם לא יוצר קישור שני
    const claimed = await timeStep("make.claim", () =>
      this.store.putIfAbsent<MakeCreateClaim>(claimKey, { fingerprint, state: "pending", result: null })
    );
    if (!claimed) return timeStep("make.await", () => this.awaitExisting(claimKey, fingerprint, providerPaymentId));

    try {
      // מכאן הבקשה עלולה להגיע ל-Make וליצור קישור ב-Grow גם אם לא קיבלנו תשובה תקינה. גם תשובת 4xx/5xx אינה הוכחה
      // שלא נוצר קישור (תרחיש יכול להחזיר כל סטטוס אחרי שכבר פנה ל-Grow), ולכן כל כשל כאן = "לא ידוע", בלי ניסיון חוזר
      const returnUrl = this.returnUrlFor(input);
      const payload: Record<string, string | undefined> = {
        reference: providerPaymentId,
        idempotencyKey: input.idempotencyKey,
        amount: agorotToShekels(input.amountAgorot),
        currency: input.currency,
        description: input.description,
        purpose: input.metadata?.packageHours ? "PACKAGE" : input.metadata?.appointmentId ? "BOOKING" : "OTHER",
        fullName: customer.fullName,
        phone: customer.phone,
        email: customer.email,
        returnUrl,
        // התראת שרת ישירה מ-Grow: מפעילה את החבילה גם אם הלקוח סגר את הדפדפן. תרחיש 1 צריך להעביר אותה ל-Grow
        notifyUrl: this.notifyUrlFor(providerPaymentId),
      };
      // מסלול הקישורים: הגוף נשאר בדיוק כפי שהיה (תאימות מלאה לתרחיש הפעיל). מסלול process: מצהירים על המסלול,
      // ושולחים cancelUrl לאותו דף החזרה (ביטול בתוך ה-iframe חוזר לאתר ולא נתקע בדף של Grow)
      if (flow === "process") {
        payload.flow = "process";
        payload.cancelUrl = returnUrl;
      }
      const target = flow === "process" ? this.cfg.process!.create : this.cfg;
      const data = await timeStep("make.http", () => this.postToMake(payload, target));
      const checkoutUrl = parseCheckoutUrl(data.url, this.cfg.allowedCheckoutHosts);
      const record: MakePaymentRecord = {
        checkoutUrl,
        flow,
        processId: optionalString(data.processId),
        processToken: optionalString(data.processToken),
        createdAt: Date.now(),
        amountAgorot: input.amountAgorot,
      };
      const result: PaymentRequestResult = { providerPaymentId, status: "PENDING", checkoutUrl };
      await timeStep("make.save", async () => {
        await this.store.put<MakePaymentRecord>(`make-payment:${providerPaymentId}`, record);
        await this.store.put<MakeCreateClaim>(claimKey, { fingerprint, state: "done", result });
      });
      return result;
    } catch (err) {
      await this.store.put<MakeCreateClaim>(claimKey, { fingerprint, state: "unknown", result: null }).catch(() => {});
      throw err;
    }
  }

  /**
   * בקשת תשלום שכבר נוצרה לפי מפתח ה-idempotency, בלי שום פנייה ל-Make (להתאוששות בשרת). null כשאין תוצאה ידועה:
   * לא נוצר קישור, או שמצב הבקשה לא ידוע - ואז לא מנחשים ולא יוצרים קישור חדש
   */
  async findExistingPaymentRequest(idempotencyKey: string): Promise<PaymentRequestResult | null> {
    if (!idempotencyKey) return null;
    const claim = await this.store.get<MakeCreateClaim>(`make-create:${idempotencyKey}`);
    if (claim?.state === "done" && claim.result) return claim.result;
    const providerPaymentId = deriveMakePaymentId(idempotencyKey);
    const record = await this.store.get<MakePaymentRecord>(`make-payment:${providerPaymentId}`);
    return record?.checkoutUrl ? { providerPaymentId, status: "PENDING", checkoutUrl: record.checkoutUrl } : null;
  }

  private returnUrlFor(input: CreatePaymentRequestInput): string | undefined {
    const base = this.cfg.returnBaseUrl?.replace(/[/]+$/, "");
    const id = input.metadata?.appointmentId;
    if (base && id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return `${base}/booking/checkout/${id}`;
    // חבילות: דף החזרה ייעודי שעובד גם בתוך חלונית התשלום (iframe) - הוא רק מבקש מהחלון המארח לבדוק סטטוס בשרת
    if (base && input.metadata?.packageHours) return `${base}${PACKAGE_RETURN_PATH}`;
    return input.returnUrl;
  }

  /** כתובת התראה חתומה לתשלום הזה. רק כשיש בסיס HTTPS של האתר (Grow דורש כתובת חיצונית) */
  notifyUrlFor(providerPaymentId: string): string | undefined {
    const base = this.cfg.returnBaseUrl?.replace(/[/]+$/, "");
    if (!base || !base.startsWith("https://")) return undefined;
    const qs = new URLSearchParams({ ref: providerPaymentId, sig: signNotifyRef(providerPaymentId, this.cfg.apiKey) });
    return `${base}${MAKE_NOTIFY_PATH}?${qs.toString()}`;
  }

  private async postToMake(
    payload: Record<string, string | undefined>,
    target: { webhookUrl: string; apiKey: string } = this.cfg
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(target.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [MAKE_API_KEY_HEADER]: target.apiKey },
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

  /**
   * אימות סטטוס דרך תרחיש האימות של Make. החוזה (אנחנו מגדירים, ו-Make ממפה אליו מתוצאת Grow): ה-Webhook response
   * מחזיר JSON עם reference ו-processId (הד של מה ששלחנו: מוודא שהתשובה שייכת לבקשה הזו), ואת העסקאות במבנה v2
   * (כל העסקאות, כל אחת קשורה למזהה הקישור כפי ש-Grow מדווח בה) או legacy (עסקה אחת) - ראו parseVerifyTransactions.
   * מטבע: תשובת Grow אינה כוללת שדה מטבע; הקישור נוצר בשקלים, ושדה currency (אם נשלח) חייב להיות ILS.
   *
   * קודי הסטטוס של Grow (parameter-mapping): 2 שולם, 0 לא שולם, 9 נדחה, 4 בוטל לפני שידור, 6 החזר. רק 2 נחשב תשלום.
   * עסקה שנדחתה או בוטלה אינה סוגרת את הרכישה: קישור התשלום עדיין פתוח, והלקוח יכול לנסות שוב באותו קישור. לכן
   * כל מצב בלי עסקה ששולמה = PENDING (והרכישה הממתינה נסגרת רק לפי מגבלת זמן, לא לפי ניסיון כושל).
   * החזר (6) שונה מדחייה: הוא מסומן ב-refundObserved, וההחלטה ב-finalize חוסמת הפעלה ומסמנת לטיפול, גם אם יש
   * בקישור עסקה ששולמה (הצלחה היסטורית אינה מספיקה).
   * SUCCEEDED: הסכום שמוחזר הוא של עסקה ששולמה (עדיפות לעסקה שסכומה זהה לסכום שביקשנו), וכל העסקאות ששולמו
   * מוחזרות ב-paidTransactions ומשויכות לתשלום הזה בלבד. ההשוואה לסכום השמור נעשית ב-finalize.
   */
  async getPaymentStatus(providerPaymentId: string): Promise<VerifiedPaymentStatus> {
    // אין שום תרחיש אימות: נכשלים מיד, לפני כל קריאה מהמסד
    if (!this.cfg.verify && !this.cfg.process) throw new PaymentError("אימות סטטוס תשלום דרך Make אינו מוגדר (תרחיש האימות חסר) - לא מוחזר סטטוס");
    const { record, view } = await this.fetchVerification(providerPaymentId, "by-flow");
    // עסקה אחת לא יכולה לאשר שני תשלומים: כל עסקה ששולמה משויכת לתשלום הראשון שאומת בה, ואם אחת מהן כבר שייכת
    // לתשלום אחר - לא מאשרים דבר
    for (const tx of view.paid) await this.claimTransaction(tx.transactionId, providerPaymentId);
    return verifiedStatusFromView(providerPaymentId, record.amountAgorot, view);
  }

  /**
   * בדיקה יבשה (קריאה בלבד) מול תרחיש אימות אחר, לבדיקת תרחיש חדש לפני שמחליפים אליו. אותו מסלול בדיוק כמו
   * getPaymentStatus (אותה בקשה, אותן בדיקות reference/processId/מטבע, אותו פענוח וקשירה למזהה הקישור), אבל בלי
   * לשייך עסקאות: רק בודקים למי הן כבר שייכות. לא כותב דבר.
   */
  async dryRunVerification(
    providerPaymentId: string,
    target: { webhookUrl: string; apiKey: string }
  ): Promise<{ view: VerifyTransactionsView; verified: VerifiedPaymentStatus; ownership: Record<string, "free" | "this" | "other"> }> {
    const { record, view } = await this.fetchVerification(providerPaymentId, target);
    const ownership: Record<string, "free" | "this" | "other"> = {};
    for (const tx of view.paid) {
      const owner = await this.store.get<{ paymentId: string }>(`make-tx:${tx.transactionId}`);
      ownership[tx.transactionId] = !owner ? "free" : owner.paymentId === providerPaymentId ? "this" : "other";
    }
    return { view, verified: verifiedStatusFromView(providerPaymentId, record.amountAgorot, view), ownership };
  }

  /** שולח לתרחיש האימות את המזהים השמורים, מוודא שהתשובה שייכת לבקשה, ומפענח את העסקאות. בלי שום כתיבה */
  private async fetchVerification(
    providerPaymentId: string,
    targetOrFlow: MakeWebhookTarget | "by-flow"
  ): Promise<{ record: MakePaymentRecord & { processId: string }; view: VerifyTransactionsView }> {
    if (!/^make:[0-9a-f]{32}$/.test(providerPaymentId)) throw new PaymentError("מזהה תשלום לא תקין");
    const record = await this.store.get<MakePaymentRecord>(`make-payment:${providerPaymentId}`);
    if (!record?.processId || !record.processToken || !Number.isInteger(record.amountAgorot)) {
      throw new PaymentError("חסרים מזהי Grow שמורים בשרת עבור התשלום - לא ניתן לאמת");
    }
    // רשומה ישנה (לפני שדה flow) נוצרה תמיד במסלול הקישורים
    const flow: MakeCheckoutFlow = record.flow === "process" ? "process" : "link";
    // תרחיש האימות נקבע לפי המסלול שבו התשלום נוצר, לא לפי ההגדרה הנוכחית. חסר = כשל זמני (התשלום נשאר ממתין)
    const target = targetOrFlow !== "by-flow" ? targetOrFlow : flow === "process" ? this.cfg.process?.verify : this.cfg.verify;
    if (!target) throw new PaymentError("אימות סטטוס תשלום דרך Make אינו מוגדר עבור מסלול התשלום (תרחיש האימות חסר) - לא מוחזר סטטוס");
    const data = await this.postToMake({ reference: providerPaymentId, processId: record.processId, processToken: record.processToken }, target);
    if (data.reference !== providerPaymentId) throw new PaymentError("תשובת האימות מ-Make אינה תואמת לתשלום המבוקש");
    // זיהוי מדויק של התשלום: Make חייב להחזיר גם את processId ששמרנו ביצירה. בלי התאמה מדויקת אין אימות
    const echoedProcess = typeof data.processId === "string" || typeof data.processId === "number" ? String(data.processId) : "";
    if (echoedProcess !== record.processId) throw new PaymentError("תשובת האימות אינה מזהה את תהליך התשלום שנשמר - לא מאושר");
    if (data.currency !== undefined && data.currency !== "ILS") throw new PaymentError("תשובת האימות כוללת מטבע שאינו ILS");
    return { record: { ...record, processId: record.processId }, view: parseVerifyTransactions(data, record.processId, flow) };
  }

  private async claimTransaction(transactionId: string, providerPaymentId: string): Promise<void> {
    const txKey = `make-tx:${transactionId}`;
    if (await this.store.putIfAbsent<{ paymentId: string }>(txKey, { paymentId: providerPaymentId })) return;
    const owner = await this.store.get<{ paymentId: string }>(txKey);
    if (owner?.paymentId !== providerPaymentId) throw new PaymentError("מזהה העסקה כבר שויך לתשלום אחר - לא מאושר");
  }

  /** כמו ב-GrowPaymentProvider: אין API לביטול קישור שלא שולם, לכן מוודאים שלא שולם ומתעדים ביטול רק אצלנו. אם האימות נכשל או שולם - זורקים */
  async cancelPayment(providerPaymentId: string): Promise<void> {
    const verified = await this.getPaymentStatus(providerPaymentId);
    if (verified.status === "SUCCEEDED") throw new PaymentError("לא ניתן לבטל: התשלום כבר הושלם");
  }

  async refund(): Promise<RefundResult> {
    throw new PaymentError("החזר אינו נתמך דרך Make");
  }

  /**
   * התראת שרת מ-Grow (notifyUrl). אימות: חתימת HMAC שהאתר שם בכתובת עצמה (Grow לא חותם). בדיקות עקביות: אם הגוף
   * כולל cField1/processId - חייבים להתאים לתשלום השמור. האירוע הוא טריגר בלבד: handlePaymentWebhook מאמת מחדש
   * דרך תרחיש האימות (getPaymentStatus) ורק אז מזכה, פעם אחת (HoursPackage.paymentId ייחודי).
   * eventId ייחודי לכל משלוח בכוונה: Grow שולח שוב עד 5 פעמים, וכל משלוח צריך לגרום לאימות נוסף (למקרה שהראשון
   * הגיע לפני ש-Grow עדכן סטטוס). זה בטוח כי האימות והזיכוי אידמפוטנטיים.
   */
  async parseWebhook(input: WebhookInput): Promise<PaymentWebhookEvent> {
    const ref = input.query?.ref ?? "";
    const sig = input.query?.sig ?? "";
    if (!verifyNotifySignature(ref, sig, this.cfg.apiKey)) throw new WebhookVerificationError("חתימת כתובת ההתראה אינה תקינה");
    const record = await this.store.get<MakePaymentRecord>(`make-payment:${ref}`);
    if (!record) throw new WebhookVerificationError("התראה לתשלום שאינו מוכר בשרת");

    const body = flattenGrowNotifyBody(input.rawBody);
    if (body.cField1 && body.cField1 !== ref) throw new WebhookVerificationError("ההתראה מתייחסת לתשלום אחר (cField1)");
    // עסקה שכבר שויכה (באימות קודם) לרכישה אחרת לא יכולה לשמש התראה לרכישה הזו
    if (body.transactionId) {
      const owner = await this.store.get<{ paymentId: string }>(`make-tx:${body.transactionId}`);
      if (owner && owner.paymentId !== ref) throw new WebhookVerificationError("העסקה בהתראה כבר שויכה לרכישה אחרת");
    }
    // processId בגוף ההתראה אינו חתום (Grow לא חותם התראות) ולכן אינו ראיה לשום כיוון. ב-Staging נמצא שהוא שונה
    // מה-processId שנשמר ביצירת הקישור, וחסימה לפיו מנעה הפעלה. לא חוסמים: מתעדים (מזהים בלבד, בלי טוקנים) וממשיכים
    // לאימות העצמאי מול Grow דרך Make לפי המזהים השמורים בשרת - הוא היחיד שמחליט, עם השוואת סכום, מטבע ועסקה
    if (body.processId && record.processId && body.processId !== record.processId) {
      console.warn(
        `[payments] notify processId differs ref=${ref} stored=${record.processId} notify=${body.processId.slice(0, 32)} tx=${body.transactionId ? "present" : "absent"} fields=${Object.keys(body).sort().join(",").slice(0, 400)}`
      );
    }
    await this.approveBestEffort(ref, body);
    return { eventId: `notify:${ref}:${randomUUID()}`, type: "payment.updated", providerPaymentId: ref };
  }

  /**
   * approveTransaction דרך תרחיש Make ייעודי (אם הוגדר). לפי Grow: נשלח pageCode (ב-Make) + כל נתוני ההתראה. אינו משנה
   * את סטטוס העסקה ואינו תנאי לזיכוי, ולכן כשל כאן נבלע. מדלגים כשאין transactionId (התראה חלקית/בדיקה)
   */
  private async approveBestEffort(ref: string, body: Record<string, string>): Promise<void> {
    if (!this.cfg.approve || !body.transactionId) return;
    const doneKey = `make-approved:${body.transactionId}`;
    if ((await this.store.get<boolean>(doneKey).catch(() => undefined)) === true) return;
    try {
      const res = await this.postToMake({ ...body, reference: ref }, this.cfg.approve);
      if (res.status === "1" || res.status === 1 || res.approved === true) await this.store.put(doneKey, true);
    } catch {
      // best-effort: Grow ישלח את ההתראה שוב, ואז ננסה לאשר שוב
    }
  }
}
