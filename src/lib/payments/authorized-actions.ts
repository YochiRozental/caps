import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { consumeAuthorization } from "@/lib/payments/authorization";
import { confirmBookingFromBalance } from "@/lib/payments/booking-payment";
import type { PaymentProvider } from "@/lib/payments/provider";
import { PaymentFlowError } from "@/lib/payments/shared";

/**
 * ביצוע פעולה בטלפון, רק מכוח הרשאה חד-פעמית (authorization.ts). ההרשאה נצרכת אטומית לפני כל פעולה, ולכן בקשה
 * חוזרת, שיחה מקבילה או נסיון להשתמש באותה הרשאה שוב לא יבצעו פעולה נוספת. הפעולה היחידה היא אישור הזמנה מיתרה
 * (confirm-balance): אין חיוב בכסף בטלפון, כי אין כרטיס שמור. תשלום בכסף מתבצע רק בדף המאובטח של Grow באתר.
 *
 * ההרשאה נשרפת גם אם הפעולה נכשלה: ניסיון נוסף מחייב אימות קוד חדש.
 */

export type AuthorizedBookingResult =
  | { status: "CONFIRMED"; paidFromBalanceMinutes: number }
  /** ההרשאה פגה, כבר נוצלה, או אינה שייכת למשתמש/להזמנה הזו */
  | { status: "AUTH_INVALID" }
  | { status: "HOLD_EXPIRED" }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "PLAN_CHANGED" };

export async function executeAuthorizedBooking(params: {
  authorizationId: string;
  userId: string;
  appointmentId: string;
  provider: PaymentProvider;
  db?: PrismaClient;
  now?: Date;
}): Promise<AuthorizedBookingResult> {
  const { authorizationId, userId, appointmentId, provider, db = defaultDb, now = new Date() } = params;

  const auth = await consumeAuthorization({ id: authorizationId, userId, appointmentId, db, now });
  if (!auth) return { status: "AUTH_INVALID" };
  if (auth.action !== "CONFIRM_BALANCE") return { status: "AUTH_INVALID" };

  try {
    const appt = await db.appointment.findUnique({ where: { id: appointmentId }, select: { startTime: true, endTime: true } });
    const minutes = appt ? (appt.endTime.getTime() - appt.startTime.getTime()) / 60_000 : -1;
    // ההרשאה אושרה לניכוי מלא של ההזמנה מהיתרה; כל חלוקה אחרת אינה מה שהלקוח אישר
    if (!appt || auth.amountAgorot !== 0 || auth.packageMinutes !== minutes) return { status: "PLAN_CHANGED" };
    const res = await confirmBookingFromBalance({ appointmentId, userId, provider, now });
    return { status: "CONFIRMED", paidFromBalanceMinutes: res.minutes };
  } catch (err) {
    if (err instanceof PaymentFlowError) {
      switch (err.code) {
        case "EXPIRED":
        case "CONFLICT":
        case "NOT_FOUND":
          return { status: "HOLD_EXPIRED" };
        case "INSUFFICIENT_BALANCE":
          return { status: "INSUFFICIENT_BALANCE" };
        case "PLAN_CHANGED":
          return { status: "PLAN_CHANGED" };
      }
    }
    throw err;
  }
}
