import { isDiagnosticsAvailable, type DiagEnv, type DiagRequest, type DiagResponse } from "@/lib/payments/make-diagnostics";
import { MIN_MAKE_API_KEY_LENGTH, MakeGrowPaymentProvider } from "@/lib/payments/make-provider";
import { decidePackageVerification } from "@/lib/payments/packages";
import { PaymentError } from "@/lib/payments/provider";

/**
 * בדיקה יבשה של תרחיש אימות חדש (Verify v2) מול רכישת חבילה אמיתית ב-Staging, לפני שמחליפים אליו את משתני האימות.
 *
 * זמינות והרשאה: כמו כלי האבחון הקיים (MAKE_DIAG_ENABLED + שער Staging פעיל, מנהל בלבד). ב-Production: 404.
 * קריאה בלבד: אותו מסלול אימות של הספק (MakeGrowPaymentProvider.dryRunVerification) ואותה החלטת הפעלה
 * (decidePackageVerification), בלי שיוך עסקאות, בלי שינוי תשלום או חבילה, בלי approveTransaction, בלי חריגה ובלי מייל.
 * התשובה: מספרים, קודי סטטוס, מזהי עסקאות והתאמות בלבד. לא כתובות, מפתחות, טוקנים או פרטי משלם.
 */

export interface DryRunEnv extends DiagEnv {
  MAKE_VERIFY_V2_WEBHOOK_URL?: string;
  MAKE_VERIFY_V2_API_KEY?: string;
}

export interface DryRunPayment {
  id: string;
  purpose: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  provider: string;
  providerPaymentId: string | null;
  amountAgorot: number;
  packageHours: number | null;
  createdAt: Date;
  hasPackage: boolean;
}

export interface DryRunRequest extends Pick<DiagRequest, "hostname" | "contentType" | "rawBody" | "authorize" | "now"> {
  env: DryRunEnv;
  provider: unknown;
  loadPayment: (id: string) => Promise<DryRunPayment | null>;
  listRecent: () => Promise<DryRunPayment[]>;
}

const PAYMENT_ID = /^[a-z0-9]{20,40}$/;
const COOLDOWN_MS = 3_000;
let lastRun = 0;
export function resetDryRunCooldown(): void {
  lastRun = 0;
}

function v2Target(env: DryRunEnv): { webhookUrl: string; apiKey: string } | null {
  const url = env.MAKE_VERIFY_V2_WEBHOOK_URL;
  const key = env.MAKE_VERIFY_V2_API_KEY;
  try {
    if (!url || new URL(url).protocol !== "https:" || !key || key.length < MIN_MAKE_API_KEY_LENGTH) return null;
  } catch {
    return null;
  }
  // תרחיש v2 חייב להיות נפרד מהתרחישים הקיימים
  if (url === env.MAKE_VERIFY_WEBHOOK_URL || url === env.MAKE_PAYMENT_WEBHOOK_URL) return null;
  return { webhookUrl: url, apiKey: key };
}

async function gate(req: Pick<DryRunRequest, "hostname" | "env" | "authorize">): Promise<DiagResponse | null> {
  if (!isDiagnosticsAvailable(req.hostname, req.env)) return { status: 404, body: { error: "לא נמצא" } };
  const auth = await req.authorize();
  if (auth === "unauthenticated") return { status: 401, body: { error: "יש להתחבר" } };
  if (auth === "forbidden") return { status: 403, body: { error: "אין הרשאה" } };
  return null;
}

const summary = (p: DryRunPayment) => ({
  id: p.id,
  createdAt: p.createdAt.toISOString(),
  status: p.status,
  hours: p.packageHours,
  amountAgorot: p.amountAgorot,
  hasPackage: p.hasPackage,
});

/** האם הכלי מוגדר + רכישות החבילה האחרונות של ספק Make (לבחירה בממשק) */
export async function handleDryRunGet(req: Pick<DryRunRequest, "hostname" | "env" | "authorize" | "listRecent">): Promise<DiagResponse> {
  const denied = await gate(req);
  if (denied) return denied;
  return { status: 200, body: { configured: v2Target(req.env) !== null, payments: (await req.listRecent()).map(summary) } };
}

export async function handleDryRunPost(req: DryRunRequest): Promise<DiagResponse> {
  const denied = await gate(req);
  if (denied) return denied;
  if (!req.contentType?.toLowerCase().startsWith("application/json")) return { status: 415, body: { error: "נדרש JSON" } };
  const bad = { status: 400, body: { error: "בקשה לא תקינה" } };
  let body: unknown;
  try {
    body = JSON.parse(req.rawBody);
  } catch {
    return bad;
  }
  // שדה אחד בלבד: מזהה התשלום. אין אפשרות להעביר כתובת, כותרות או מזהי Grow
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad;
  const keys = Object.keys(body);
  const paymentId = (body as Record<string, unknown>).paymentId;
  if (keys.length !== 1 || typeof paymentId !== "string" || !PAYMENT_ID.test(paymentId)) return bad;

  const target = v2Target(req.env);
  if (!target) return { status: 409, body: { error: "תרחיש Verify v2 אינו מוגדר (MAKE_VERIFY_V2_WEBHOOK_URL / MAKE_VERIFY_V2_API_KEY)" } };
  if (!(req.provider instanceof MakeGrowPaymentProvider)) return { status: 409, body: { error: "ספק התשלום הפעיל אינו Make" } };

  const payment = await req.loadPayment(paymentId);
  if (!payment || payment.purpose !== "PACKAGE" || payment.provider !== req.provider.name) return { status: 404, body: { error: "רכישת חבילה לא נמצאה" } };
  if (!payment.providerPaymentId) return { status: 409, body: { error: "לרכישה אין קישור תשלום" } };

  const now = (req.now ?? Date.now)();
  if (now - lastRun < COOLDOWN_MS) return { status: 429, body: { error: "נא להמתין מספר שניות בין בדיקות" } };
  lastRun = now;

  const started = Date.now();
  try {
    const { view, verified, ownership } = await req.provider.dryRunVerification(payment.providerPaymentId, target);
    const otherOwned = Object.values(ownership).includes("other");
    let decision: string;
    if (otherOwned) decision = "REJECTED_TRANSACTION_OF_OTHER_PURCHASE";
    else if (payment.hasPackage) {
      // חבילה שכבר הופעלה לעולם לא מזוכה שוב; בהתראה הייתה נבדקת רק חריגה
      const flags = [verified.paidTransactions && verified.paidTransactions.length > 1 ? "MULTIPLE_PAID" : "", verified.refundObserved ? "REFUNDED" : ""].filter(Boolean);
      decision = flags.length ? `ALREADY_ACTIVATED + FLAG ${flags.join(" + ")}` : "ALREADY_ACTIVATED";
    } else if (payment.status === "SUCCEEDED") decision = "ACTIVATE (התשלום כבר אומת)";
    else {
      const d = decidePackageVerification(payment.status, payment.amountAgorot, verified);
      decision =
        d.action === "ACTIVATE"
          ? `ACTIVATE${d.multiplePaid ? " + FLAG MULTIPLE_PAID" : ""}`
          : d.action === "RETURN"
            ? d.outcome
            : d.action === "MARK"
              ? `MARK_${d.status}`
              : d.action === "REVIEW_REFUNDED"
                ? "REVIEW (REFUNDED)"
                : "REVIEW (PAID_AFTER_CANCEL)";
    }
    return {
      status: 200,
      body: {
        result: {
          ok: true,
          durationMs: Date.now() - started,
          payment: summary(payment),
          // תשובה אחת: גוף JSON יחיד שפוענח במלואו. v2 = כל העסקאות של הקישור במערך אחד
          responseFormat: view.format,
          transactionCount: view.statusCodes.length,
          statusCodes: view.statusCodes,
          paid: view.paid.map((t) => ({ transactionId: t.transactionId, amountAgorot: t.amountAgorot, amountMatches: t.amountAgorot === payment.amountAgorot, owner: ownership[t.transactionId] })),
          refundCount: view.refunds.length,
          // ב-v2 כל עסקה ששולמה/הוחזרה נבדקה מול מזהה הקישור השמור (אחרת הפענוח נכשל). ב-legacy אין שדה כזה
          linkIdVerified: view.format === "v2",
          amountMatches: verified.status === "SUCCEEDED" ? verified.amountAgorot === payment.amountAgorot : null,
          decision,
        },
      },
    };
  } catch (err) {
    // הודעות PaymentError נכתבות בקוד שלנו ואינן כוללות כתובות, מפתחות או טוקנים
    const message = err instanceof PaymentError ? err.message.slice(0, 200) : "שגיאה לא צפויה";
    return { status: 200, body: { result: { ok: false, durationMs: Date.now() - started, payment: summary(payment), error: message } } };
  }
}
