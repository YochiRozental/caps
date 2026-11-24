/**
 * לוגיקה טהורה (ללא React/DOM גלובלי) לחלונית התשלום המוטמעת של Grow ולדף החזרה. כל מה שכאן הוא חוויית משתמש בלבד:
 * שום ערך מכאן לא מסמן תשלום כשולם. ההחלטה היחידה על הצלחה היא תשובת השרת מ-GET /api/payments/[id], שמאמת מול
 * Grow (דרך תרחיש האימות של Make) ומזכה בשעות פעם אחת בלבד (HoursPackage.paymentId ייחודי).
 */

/** סוג ההודעה שדף החזרה שולח לחלון המארח. רק "רמז" לבדוק סטטוס מול השרת, לעולם לא הוכחת תשלום */
export const RETURN_MESSAGE_TYPE = "caps:payment-return";

/** הנתיב שאליו Grow מחזיר (successUrl/cancelUrl). נבנה בשרת בלבד (make-provider.ts) */
export const PACKAGE_RETURN_PATH = "/payments/return";

/** קישור תהליך התשלום של Grow תקף כ-10 דקות מיצירתו (createPaymentProcess). אחרי זה לא מציעים לפתוח אותו שוב */
export const CHECKOUT_LINK_TTL_MS = 9 * 60 * 1000;

/** אם ה-iframe לא נטען בזמן הזה - מציעים בבירור פתיחה בחלון חיצוני */
export const IFRAME_LOAD_TIMEOUT_MS = 15_000;

/** אחרי חזרה מדף התשלום: כמה זמן ממתינים לאישור שרת לפני שמציגים "התשלום בבדיקה, אפשר לסגור" */
export const CONFIRMATION_GRACE_MS = 45_000;

export type ReturnHint = "success" | "cancel" | "unknown";

export interface ReturnMessage {
  type: typeof RETURN_MESSAGE_TYPE;
  hint: ReturnHint;
}

/** Grow מוסיף לכתובת ההחזרה response=success (ובביטול/כשל ערכים אחרים). זה רמז תצוגה בלבד */
export function returnHintFromSearch(search: string): ReturnHint {
  const value = new URLSearchParams(search).get("response")?.toLowerCase() ?? "";
  if (value === "success") return "success";
  if (value === "cancel" || value === "cancelled" || value === "failure" || value === "failed") return "cancel";
  return "unknown";
}

export function buildReturnMessage(search: string): ReturnMessage {
  return { type: RETURN_MESSAGE_TYPE, hint: returnHintFromSearch(search) };
}

/**
 * מקבלים הודעה רק אם: היא מאותו origin של האתר (דף החזרה שלנו, לא דף Grow ולא צד שלישי), היא הגיעה מה-iframe
 * שפתחנו (או מהחלון החיצוני שפתחנו), והמבנה תקין. כל דבר אחר מתעלמים ממנו בשקט.
 */
export function parseReturnMessage(
  event: { origin: string; data: unknown; source: unknown },
  expected: { origin: string; sources: readonly unknown[] }
): ReturnMessage | null {
  if (event.origin !== expected.origin) return null;
  if (!event.source || !expected.sources.includes(event.source)) return null;
  const data = event.data as Partial<ReturnMessage> | null;
  if (!data || typeof data !== "object" || data.type !== RETURN_MESSAGE_TYPE) return null;
  const hint: ReturnHint = data.hint === "success" || data.hint === "cancel" ? data.hint : "unknown";
  return { type: RETURN_MESSAGE_TYPE, hint };
}

/** מה דף החזרה עושה: בתוך iframe מודיע לחלון המארח; בחלון חיצוני שנפתח מהאתר מודיע ונסגר; אחרת חוזר לדף השעות */
export type ReturnPageAction = "notify-parent" | "notify-opener" | "redirect";

export function returnPageAction(ctx: { inIframe: boolean; hasOpener: boolean }): ReturnPageAction {
  if (ctx.inIframe) return "notify-parent";
  if (ctx.hasOpener) return "notify-opener";
  return "redirect";
}

/** בדיקת צד לקוח לפני הטמעה: HTTPS בלבד ובלי פרטי גישה. רשימת הדומיינים המאושרים נאכפת בשרת (parseCheckoutUrl) */
export function isEmbeddableCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** שלב החלונית אחרי שהקישור מוכן: iframe רק כשלא ידוע שהספק אוסר הטמעה */
export function checkoutPhaseFor(embeddable: boolean | undefined): "checkout" | "external-ready" {
  return embeddable === false ? "external-ready" : "checkout";
}

// ───────────────────────────── רכישה ממתינה (sessionStorage) ─────────────────────────────

export interface StoredPurchase {
  paymentId: string;
  providerPaymentId?: string;
  hours: number;
  amountAgorot: number;
  /** קישור התשלום, כדי לאפשר "חזרה לדף התשלום" אחרי סגירת החלונית. לא סוד: אינו כולל processToken */
  checkoutUrl?: string;
  /** מתי נוצר הקישור (ms). משמש רק כדי לא להציע קישור שפג */
  checkoutCreatedAt?: number;
  /** false = הספק אוסר הטמעה (נבדק בשרת לפי כותרות האבטחה שלו): הדף ייפתח בחלון נפרד */
  embeddable?: boolean;
}

const PAYMENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** קריאה סלחנית של הרכישה השמורה: ערך פגום או חסר -> null (לא זורקים) */
export function parseStoredPurchase(raw: string | null): StoredPurchase | null {
  if (!raw) return null;
  let v: Partial<StoredPurchase>;
  try {
    v = JSON.parse(raw) as Partial<StoredPurchase>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || typeof v.paymentId !== "string" || !PAYMENT_ID.test(v.paymentId)) return null;
  if (!Number.isInteger(v.hours) || !Number.isInteger(v.amountAgorot)) return null;
  const out: StoredPurchase = { paymentId: v.paymentId, hours: v.hours as number, amountAgorot: v.amountAgorot as number };
  if (typeof v.providerPaymentId === "string") out.providerPaymentId = v.providerPaymentId;
  if (isEmbeddableCheckoutUrl(v.checkoutUrl) && typeof v.checkoutCreatedAt === "number") {
    out.checkoutUrl = v.checkoutUrl;
    out.checkoutCreatedAt = v.checkoutCreatedAt;
  }
  if (v.embeddable === false) out.embeddable = false;
  return out;
}

/** האם עדיין סביר לפתוח מחדש את דף התשלום (הקישור של Grow פג אחרי כ-10 דקות) */
export function canReopenCheckout(p: StoredPurchase, now: number): boolean {
  return !!p.checkoutUrl && typeof p.checkoutCreatedAt === "number" && now - p.checkoutCreatedAt < CHECKOUT_LINK_TTL_MS;
}

// ───────────────────────────── תוצאת אימות השרת ─────────────────────────────

export type PurchaseResolution = "activated" | "failed" | "cancelled" | "mismatch" | "review" | "pending";

/** מיפוי outcome של השרת (finalizePackagePayment). רק PACKAGE_ACTIVATED/ALREADY_ACTIVATED נחשבים הצלחה */
export function resolvePurchaseOutcome(outcome: unknown): PurchaseResolution {
  switch (outcome) {
    case "PACKAGE_ACTIVATED":
    case "ALREADY_ACTIVATED":
      return "activated";
    case "PAYMENT_FAILED":
      return "failed";
    case "PAYMENT_CANCELLED":
      return "cancelled";
    case "AMOUNT_MISMATCH":
      return "mismatch";
    case "PAYMENT_REVIEW":
      return "review";
    default:
      return "pending";
  }
}

// ───────────────────────────── שחזור רכישות שלא נסגרו ─────────────────────────────

const RECOVERY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_RECOVERY = 3;

/**
 * רכישות חבילה שעדיין PENDING בשרת (מתוך היסטוריית המשתמש), מהיומיים האחרונים: למשל לקוח ששילם וסגר את הדפדפן
 * לפני שהאישור התקבל. הדף מבקש מהשרת לאמת אותן, וכך החבילה מופעלת גם בלי ה-sessionStorage של הלשונית המקורית.
 * מזהה רשומת ההיסטוריה הוא "pay:<paymentId>".
 */
export function pendingPackagePaymentIds(
  entries: readonly { id: string; kind: string; status?: string; at: string }[],
  now: number
): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    if (e.kind !== "PACKAGE_PURCHASE" || e.status !== "PENDING" || !e.id.startsWith("pay:")) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || now - at > RECOVERY_WINDOW_MS) continue;
    const id = e.id.slice(4);
    if (PAYMENT_ID.test(id)) ids.push(id);
    if (ids.length >= MAX_RECOVERY) break;
  }
  return ids;
}
