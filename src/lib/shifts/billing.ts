import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { jerusalemTodayIso } from "@/lib/jerusalem-time";
import type { PaymentProvider } from "@/lib/payments/provider";
import { audit, isUniqueViolation } from "@/lib/payments/shared";
import { billingMonths, monthKeyOf } from "@/lib/shifts/calendar";
import { writeAudit } from "@/lib/finance/audit";
import { CRON_STALE_RUN_MS, MAKEUP_CREDIT_VALIDITY_DAYS, SHIFT_BILLING_JOB, SHIFT_GRACE_DAYS } from "@/lib/shifts/policy";

/**
 * מעקב חודשי אחרי חיובי משמרות: בדיוק שלושה חיובים, במועדים שמחושבים מתאריך ההתחלה (calendar.ts). שורה אחת ב-ShiftCharge
 * לכל (משמרת, מפתח חודש), שנוצרת מראש ביצירת המשמרת. הסכום הוא תמיד המחיר החודשי הקבוע של המשמרת (בלי חישוב יחסי).
 *
 * אין כרטיס שמור ואין חיוב אוטומטי: כל משמרת מנוהלת בתשלום ידני, והמנהל מתעד כל תשלום שהתקבל (recordManualPayment).
 * הריצה היומית רק מסמנת תשלום ידני שלא התקבל במועד (תקופת חסד ואז השעיה), נותנת שעות חלופיות ומסיימת משמרות שהסתיימו.
 */

const DAY_MS = 24 * 3600_000;

export function graceDeadline(from: Date): Date {
  return new Date(from.getTime() + SHIFT_GRACE_DAYS * DAY_MS);
}

export function currentMonthKey(now: Date): string {
  return monthKeyOf(jerusalemTodayIso(now));
}

// ───────────────────────────── הרצה יומית ─────────────────────────────

export interface BillingRunSummary {
  period: string;
  /** חיובים ידניים שלא התקבלו במועד ונכנסו לתקופת חסד */
  manualOverdue: number;
  suspended: number;
  ended: number;
  /** זיכויי שעות חלופיות שניתנו בריצה זו (רשת ביטחון להשלמה) */
  makeupGranted: number;
  errors: number;
}

export type BillingRunResult =
  | { outcome: "ALREADY_RUNNING" }
  | { outcome: "DONE"; runId: string; status: "SUCCEEDED" | "PARTIAL" | "FAILED"; summary: BillingRunSummary };

/** תפיסת הריצה: שורת CronRun בסטטוס RUNNING אחת לכל עבודה (אינדקס ייחודי חלקי). ריצה נטושה (stale) נלקחת */
async function acquireRun(db: PrismaClient, params: { period: string; trigger: string; now: Date }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.cronRun.create({ data: { job: SHIFT_BILLING_JOB, period: params.period, trigger: params.trigger, startedAt: params.now } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const running = await db.cronRun.findFirst({ where: { job: SHIFT_BILLING_JOB, status: "RUNNING" } });
      if (running && params.now.getTime() - running.startedAt.getTime() < CRON_STALE_RUN_MS) return null;
      if (running) {
        await db.cronRun.updateMany({
          where: { id: running.id, status: "RUNNING" },
          data: { status: "FAILED", finishedAt: params.now, summary: { reason: "stale_run_taken_over" } },
        });
      }
    }
  }
  return null;
}

/**
 * הרצה יומית (מיועדת ל-Render Cron, מדי יום; אידמפוטנטית לחלוטין, כך שהרצה חוזרת/כפולה בטוחה). אינה מחייבת דבר:
 *  1) תשלום ידני שלא התקבל במועדו נכנס לתקופת חסד  2) השעיית משמרות שתקופת החסד שלהן חלפה
 *  3) זיכוי שעות חלופיות שטרם ניתן  4) סיום משמרות שתקופתן חלפה וכל חודשיהן שולמו/אופסו.
 * ריצה אחת בכל רגע (CronRun). כל ריצה ותוצאותיה מתועדות.
 */
export async function runMonthlyShiftBilling(params: { trigger: string; now?: Date; db?: PrismaClient }): Promise<BillingRunResult> {
  const { trigger, now = new Date(), db = defaultDb } = params;
  const period = currentMonthKey(now);
  const run = await acquireRun(db, { period, trigger, now });
  if (!run) return { outcome: "ALREADY_RUNNING" };

  const summary: BillingRunSummary = { period, manualOverdue: 0, suspended: 0, ended: 0, makeupGranted: 0, errors: 0 };
  let fatal = false;
  try {
    // 1) תשלום ידני שלא התקבל במועדו: נכנס למנגנון החובות (תקופת חסד של 7 ימים ואז השעיה)
    const todayIso = jerusalemTodayIso(now);
    const overdue = await db.shiftCharge.findMany({
      where: { status: "PENDING", dueDate: { lt: todayIso }, shift: { status: "ACTIVE" } },
      include: { shift: { select: { userId: true } } },
    });
    for (const c of overdue) {
      try {
        const { count } = await db.shiftCharge.updateMany({
          where: { id: c.id, status: "PENDING" },
          data: { status: "FAILED", failureCode: "manual_payment_overdue", graceUntil: graceDeadline(now), lastAttemptAt: now, claimedAt: null },
        });
        if (count === 1) {
          summary.manualOverdue++;
          await writeAudit(db, { action: "shift_charge.manual_overdue", userId: c.shift.userId, entityType: "ShiftCharge", entityId: c.id, outcome: "ok", reason: `due:${c.dueDate}`, before: { status: "PENDING" }, after: { status: "FAILED", failureCode: "manual_payment_overdue" } });
        }
      } catch {
        summary.errors++;
      }
    }

    // 2) השעיה: חיוב שלא שולם ותקופת החסד שלו חלפה
    const expired = await db.shiftCharge.findMany({ where: { status: "FAILED", graceUntil: { lte: now }, shift: { status: "ACTIVE" } }, select: { shiftId: true, month: true } });
    const suspendShifts = [...new Map(expired.map((e) => [e.shiftId, e])).values()];
    for (const e of suspendShifts) {
      const { count } = await db.shift.updateMany({
        where: { id: e.shiftId, status: "ACTIVE" },
        data: { status: "SUSPENDED", suspendedAt: now, suspensionReason: `payment_failed:${e.month}` },
      });
      summary.suspended += count;
      if (count === 1) await writeAudit(db, { action: "shift.suspended_nonpayment", entityType: "Shift", entityId: e.shiftId, outcome: "ok", reason: `payment_failed:${e.month}` });
    }

    // 3) רשת ביטחון: זיכוי שעות חלופיות שטרם ניתן למפגשים שדולגו במשמרות פעילות
    summary.makeupGranted += (await grantMakeupCredits(db, now)).granted;

    // 4) סיום: משמרת שתקופתה חלפה וכל חודשיה שולמו/אופסו
    const finished = await db.shift.findMany({ where: { status: "ACTIVE", endDate: { lt: todayIso } }, include: { charges: true } });
    for (const shift of finished) {
      const months = billingMonths(shift.startDate);
      const settled = months.every((m) => {
        const c = shift.charges.find((x) => x.month === m);
        return c && (c.status === "PAID" || c.status === "WAIVED");
      });
      if (settled) {
        const { count } = await db.shift.updateMany({ where: { id: shift.id, status: "ACTIVE" }, data: { status: "ENDED" } });
        summary.ended += count;
      }
    }
  } catch {
    fatal = true;
    summary.errors++;
  }

  const status = fatal ? "FAILED" : summary.errors > 0 ? "PARTIAL" : "SUCCEEDED";
  await db.cronRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), summary: summary as never } });
  return { outcome: "DONE", runId: run.id, status, summary };
}

// ───────────────────────────── החזר על מופע ששולם ─────────────────────────────

/**
 * החזר חלקי על חיוב חודשי ששולם (סגירת יום מפורשת / ביטול מאושר). אידמפוטנטי לפי מפתח; לעולם לא מחזיר יותר ממה שנגבה.
 * מחזיר את הסכום שהוחזר בפועל (0 אם אין מה להחזיר או שהספק נכשל; השורה נשארת למעקב ולניסיון חוזר).
 */
export async function refundChargeAmount(params: {
  db?: PrismaClient;
  provider: PaymentProvider;
  chargeId: string;
  amountAgorot: number;
  key: string;
  reason: string;
  createdById?: string;
}): Promise<number> {
  const { db = defaultDb, provider, chargeId, amountAgorot, key, reason, createdById } = params;
  const charge = await db.shiftCharge.findUniqueOrThrow({ where: { id: chargeId }, include: { payment: { include: { refunds: true } } } });
  const payment = charge.payment;
  if (charge.status !== "PAID" || !payment || payment.status !== "SUCCEEDED" || !payment.providerPaymentId) return 0;

  const existing = payment.refunds.find((r) => r.idempotencyKey === key);
  if (existing?.status === "SUCCEEDED") return existing.amountAgorot;
  const refundedSoFar = payment.refunds.filter((r) => r.status !== "FAILED").reduce((n, r) => n + r.amountAgorot, 0);
  const amount = Math.min(amountAgorot, payment.amountAgorot - refundedSoFar);
  if (amount <= 0) return 0;

  let refund = existing;
  if (!refund) {
    try {
      refund = await db.refund.create({ data: { paymentId: payment.id, amountAgorot: amount, status: "PENDING", reason, idempotencyKey: key, createdById } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      refund = await db.refund.findUniqueOrThrow({ where: { idempotencyKey: key } });
      if (refund.status === "SUCCEEDED") return refund.amountAgorot;
    }
  }
  try {
    const res = await provider.refund({ providerPaymentId: payment.providerPaymentId, amountAgorot: refund.amountAgorot, idempotencyKey: key, reason });
    if (res.status !== "SUCCEEDED") return 0;
    await db.$transaction([
      db.refund.update({ where: { id: refund.id }, data: { status: "SUCCEEDED", providerRefundId: res.providerRefundId } }),
      db.shiftCharge.update({ where: { id: chargeId }, data: { refundedAgorot: { increment: refund.amountAgorot } } }),
    ]);
    return refund.amountAgorot;
  } catch {
    await audit(payment.id, "refund", "error", "shift_refund_failed");
    return 0;
  }
}

// ───────────────────────────── שחרור משבצות של משמרת שלא אושרה ─────────────────────────────

/** משחרר משמרת שלא אושרה: מבטל את הזמנות המפגשים, מסמן את המפגשים והמשמרת כמבוטלים. לא מוחק היסטוריה */
export async function abortPendingShift(db: PrismaClient, shiftId: string, reason: string, now: Date) {
  await db.$transaction(async (tx) => {
    const occurrences = await tx.shiftOccurrence.findMany({ where: { shiftId, status: "SCHEDULED" } });
    const appointmentIds = occurrences.map((o) => o.appointmentId).filter((x): x is string => !!x);
    await tx.appointment.updateMany({ where: { id: { in: appointmentIds }, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
    await tx.shiftOccurrence.updateMany({ where: { shiftId, status: "SCHEDULED" }, data: { status: "CANCELLED", statusNote: reason } });
    await tx.shift.updateMany({ where: { id: shiftId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason } });
    // משמרת שלא אושרה: אין זכאות לשעות חלופיות על ימים שנסגרו לפני האישור (זיכוי ניתן רק למשמרת פעילה)
    await tx.shiftOccurrence.updateMany({ where: { shiftId, makeupStatus: "OWED", makeupCreditId: null }, data: { makeupStatus: null, statusNote: reason } });
  });
}

// ───────────────────────────── שעות חלופיות: זיכוי בדקות ─────────────────────────────

/**
 * נותן זיכוי (Credit, המנגנון הקיים של יתרות דקות) על כל מפגש שדולג בגלל סגירה ביוזמת ההנהלה: בדיוק משך המפגש שבוטל
 * (4 שעות = 240 דקות, 3 שעות = 180). רק למשמרת פעילה (לא למשמרת שעדיין ממתינה לחיוב הראשון), פעם אחת לכל מפגש
 * (אילוץ ייחודיות על makeupCreditId). אידמפוטנטי ובטוח להפעלה חוזרת/מקבילית. אינו נוגע בחיובי המשמרת.
 * הלקוח מממש את הזיכוי כמו כל יתרה: "אישור מהיתרה" בהזמנת חדר, או שיבוץ ע"י מנהל. הזיכוי פוקע אחרי MAKEUP_CREDIT_VALIDITY_DAYS.
 */
export async function grantMakeupCredits(db: PrismaClient, now: Date, filter: { shiftId?: string; date?: string } = {}): Promise<{ granted: number; minutes: number }> {
  const pending = await db.shiftOccurrence.findMany({
    where: {
      status: "SKIPPED_CLOSED_DAY",
      makeupStatus: "OWED",
      makeupCreditId: null,
      shift: { status: "ACTIVE", ...(filter.shiftId ? { id: filter.shiftId } : {}) },
      ...(filter.date ? { date: filter.date } : {}),
    },
    include: { shift: { select: { userId: true, room: { select: { key: true } } } } },
    take: 500,
  });
  let granted = 0;
  let minutes = 0;
  for (const occ of pending) {
    const duration = Math.round((occ.endTime.getTime() - occ.startTime.getTime()) / 60_000);
    if (duration <= 0) continue;
    try {
      await db.$transaction(async (tx) => {
        const credit = await tx.credit.create({
          data: {
            userId: occ.shift.userId,
            minutesTotal: duration,
            minutesRemaining: duration,
            // שעה חלופית של משמרת בחדר סדנאות מנוצלת רק בחדר סדנאות
            workshop: occ.shift.room.key === "WORKSHOP",
            expiresAt: new Date(now.getTime() + MAKEUP_CREDIT_VALIDITY_DAYS * 24 * 3_600_000),
            reason: `shift_makeup:${occ.id}`,
            sourceAppointmentId: occ.appointmentId,
          },
        });
        const { count } = await tx.shiftOccurrence.updateMany({ where: { id: occ.id, makeupStatus: "OWED", makeupCreditId: null }, data: { makeupCreditId: credit.id, makeupUpdatedAt: now } });
        if (count !== 1) throw new Error("makeup already granted");
        await writeAudit(tx, { action: "shift_makeup.granted", userId: occ.shift.userId, entityType: "ShiftOccurrence", entityId: occ.id, outcome: "ok", after: { minutes: duration, creditId: credit.id, date: occ.date } });
      });
      granted++;
      minutes += duration;
    } catch {
      // מתן כפול/מקביל נדחה באילוץ; ממשיכים לשאר המפגשים
    }
  }
  return { granted, minutes };
}
