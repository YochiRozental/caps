import type { PaymentAnomalyKind, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { sendAdminAlertEmail } from "@/lib/notifications";
import type { PaidTransaction } from "@/lib/payments/provider";
import { isUniqueViolation } from "@/lib/payments/shared";

/**
 * חריגות תשלום: מצבים שבהם הלקוח חויב אצל הספק, אבל המערכת בכוונה לא זיכתה אוטומטית (תשלום אחרי ביטול), או זיכתה
 * פעם אחת בלבד למרות כמה חיובים (חיוב מרובה). כל חריגה נשמרת במסד (PaymentAnomaly) ונשלחת עליה התראה למנהלים.
 *
 *  - תיעוד אידמפוטנטי: אותה חריגה (תשלום + סוג + אותן עסקאות) נרשמת פעם אחת, גם בהתראות כפולות או מקבילות.
 *  - התראה עד הצלחה: כל עוד לא נשלחה, כל זיהוי חוזר (התראה חוזרת מ-Grow, בדיקה מהדפדפן) מנסה שוב, לכל היותר פעם
 *    ב-ALERT_RETRY_MS. כשל בשליחה לעולם אינו מפיל את עיבוד התשלום.
 *  - בלי מידע רגיש: מזהי עסקאות וסכומים בלבד. בלי טוקנים, פרטי כרטיס, שם או טלפון.
 */

export const ALERT_RETRY_MS = 10 * 60_000;

type Db = Pick<PrismaClient, "paymentAnomaly">;
type SendAlert = (alert: { subject: string; text: string }) => Promise<void>;

const KIND_TEXT: Record<PaymentAnomalyKind, { subject: string; action: string }> = {
  MULTIPLE_PAID: {
    subject: "חיוב מרובה ברכישת חבילה",
    action: "החבילה הופעלה פעם אחת בלבד. יש לבדוק ב-Grow ולהחזיר את החיוב הנוסף.",
  },
  PAID_AFTER_CANCEL: {
    subject: "התקבל תשלום עבור רכישה שבוטלה",
    action: "החבילה לא הופעלה אוטומטית. יש לבדוק ב-Grow ולהחליט: להפעיל ידנית או להחזיר את התשלום.",
  },
  REFUNDED: {
    subject: "נמצאה עסקת החזר ב-Grow לרכישת חבילה",
    action: "רכישה שטרם הופעלה לא תופעל אוטומטית. אם החבילה כבר הופעלה, השעות לא ירדו: יש לבדוק ולעדכן ידנית.",
  },
};

export function anomalyFingerprint(transactions: readonly PaidTransaction[]): string {
  return [...new Set(transactions.map((t) => t.transactionId))].sort().join(",").slice(0, 1000);
}

/**
 * רושם חריגה (אם טרם נרשמה) ומנסה לשלוח עליה התראה. מחזיר את מזהה החריגה והאם נרשמה עכשיו (לתיעוד אצל הקורא).
 * כשל ברישום עצמו זורק (המסד לא זמין), כדי שהקורא לא ידווח "טופל" על מצב שלא תועד; כשל בהתראה נבלע ונרשם על החריגה.
 */
export async function recordPaymentAnomaly(params: {
  paymentId: string;
  kind: PaymentAnomalyKind;
  transactions: readonly PaidTransaction[];
  environment: string;
  now?: Date;
  db?: Db;
  send?: SendAlert;
}): Promise<{ id: string; created: boolean }> {
  const { paymentId, kind, transactions, environment, now = new Date(), db = defaultDb, send = sendAdminAlertEmail } = params;
  const transactionIds = anomalyFingerprint(transactions);
  const paidAgorot = transactions.reduce((sum, t) => sum + t.amountAgorot, 0);

  let id: string;
  let created = false;
  try {
    id = (await db.paymentAnomaly.create({ data: { paymentId, kind, transactionIds, paidAgorot }, select: { id: true } })).id;
    created = true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    id = (await db.paymentAnomaly.findUniqueOrThrow({
      where: { paymentId_kind_transactionIds: { paymentId, kind, transactionIds } },
      select: { id: true },
    })).id;
  }
  if (created) console.warn(`[payments] anomaly ${kind} payment=${paymentId} transactions=${transactions.length}`);
  await alertAnomaly({ anomalyId: id, environment, now, db, send });
  return { id, created };
}

/**
 * שולח התראה על חריגה שטרם נשלחה. תפיסה אטומית (updateMany מותנה) מבטיחה שרק קורא אחד שולח בכל חלון ניסיון, גם
 * כשכמה התראות מגיעות במקביל. מחזיר true אם נשלחה עכשיו.
 */
export async function alertAnomaly(params: { anomalyId: string; environment: string; now?: Date; db?: Db; send?: SendAlert }): Promise<boolean> {
  const { anomalyId, environment, now = new Date(), db = defaultDb, send = sendAdminAlertEmail } = params;
  const retryBefore = new Date(now.getTime() - ALERT_RETRY_MS);
  const { count } = await db.paymentAnomaly.updateMany({
    where: {
      id: anomalyId,
      alertSentAt: null,
      status: "OPEN",
      OR: [{ lastAlertAttemptAt: null }, { lastAlertAttemptAt: { lt: retryBefore } }],
    },
    data: { lastAlertAttemptAt: now, alertAttempts: { increment: 1 } },
  });
  if (count !== 1) return false;

  const anomaly = await db.paymentAnomaly.findUniqueOrThrow({ where: { id: anomalyId } });
  const kind = KIND_TEXT[anomaly.kind];
  const env = environment === "live" ? "" : "[Sandbox/Staging] ";
  const text = [
    kind.subject,
    "",
    `סביבה: ${environment}`,
    `מזהה תשלום במערכת: ${anomaly.paymentId}`,
    `מזהי עסקאות ב-Grow: ${anomaly.transactionIds}`,
    `${anomaly.kind === "REFUNDED" ? "סך הכול הוחזר" : "סך הכול שולם"}: ${(anomaly.paidAgorot / 100).toFixed(2)} ₪`,
    `זוהה: ${anomaly.createdAt.toISOString()}`,
    "",
    kind.action,
    "החריגה נשמרת במסד בטבלה PaymentAnomaly (סטטוס OPEN) עד לסגירה ידנית.",
  ].join("\n");
  try {
    await send({ subject: `${env}${kind.subject}`, text });
    await db.paymentAnomaly.update({ where: { id: anomalyId }, data: { alertSentAt: new Date(), lastAlertError: null } });
    return true;
  } catch (err) {
    const code = err instanceof Error && /^[a-z_]{1,40}$/.test(err.message) ? err.message : err instanceof Error ? err.name : "error";
    console.error(`[payments] anomaly alert failed anomaly=${anomalyId}: ${code}`);
    await db.paymentAnomaly.update({ where: { id: anomalyId }, data: { lastAlertError: code } }).catch(() => {});
    return false;
  }
}
