import { prisma } from "@/lib/prisma";
import { findHoursPackage, packageExpiry, packageMinutes } from "@/lib/payments/pricing";
import { getRegularPricing, packageOptionsFor } from "@/lib/payments/pricing-db";
import type { PaidTransaction, PaymentProvider, VerifiedPaymentStatus } from "@/lib/payments/provider";
import { recordPaymentAnomaly } from "@/lib/payments/anomalies";
import { timeStep } from "@/lib/payments/timing";
import {
  PaymentFlowError,
  audit,
  environmentOf,
  isUniqueViolation,
  lockPaymentRow,
} from "@/lib/payments/shared";

/**
 * רכישת חבילות שעות. חבילה נוצרת אך ורק ב-finalizePackagePayment, אחרי שהסטטוס נשלף מהספק בצד השרת והסכום אומת
 * מול טבלת המחירים. אין "חבילה ממתינה": תשלום שנכשל או לא הושלם לא יוצר יתרה.
 */

const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export interface StartedPackagePurchase {
  paymentId: string;
  providerPaymentId?: string;
  checkoutUrl?: string;
  hours: number;
  /** כרטיסיית חדר סדנאות */
  workshop: boolean;
  amountAgorot: number;
  status: string;
}

/**
 * פותח רכישת חבילה. המחיר נקבע בשרת מטבלת המחירים לפי מספר השעות בלבד (שום סכום מהלקוח).
 * clientKey: מפתח אקראי שהלקוח יוצר פעם אחת לכל "כוונת רכישה". אותו מפתח (לחיצה כפולה, רענון) מחזיר את אותו תשלום;
 * רכישה נוספת מכוונת של אותה חבילה משתמשת במפתח חדש.
 */
export async function startPackagePurchase(params: {
  userId: string;
  hours: number;
  /** כרטיסיית חדר סדנאות (מחיר נפרד, ומנוצלת רק להזמנות בחדר סדנאות). ברירת מחדל: כרטיסייה רגילה */
  workshop?: boolean;
  clientKey: string;
  provider: PaymentProvider;
}): Promise<StartedPackagePurchase> {
  const { userId, hours, clientKey, provider, workshop = false } = params;

  const user = await timeStep("db.user", () => prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } }));
  if (!user) throw new PaymentFlowError("המשתמש לא נמצא", "NOT_FOUND");
  // התפקיד והסטטוס נבדקים מול המסד ולא מול ה-session
  if (user.role !== "CLIENT" || user.status !== "APPROVED") {
    throw new PaymentFlowError("רק לקוח מאושר רשאי לרכוש חבילה", "FORBIDDEN");
  }
  const pricing = await timeStep("db.pricing", () => getRegularPricing());
  const option = findHoursPackage(hours, packageOptionsFor(pricing, workshop));
  if (!option) throw new PaymentFlowError("חבילה לא קיימת", "INVALID");
  if (!CLIENT_KEY.test(clientKey)) throw new PaymentFlowError("מפתח הבקשה אינו תקין", "INVALID");

  const idempotencyKey = `package:${userId}:${clientKey}`;
  let payment;
  try {
    payment = await timeStep("db.payment", () => prisma.payment.create({
      data: {
        userId,
        purpose: "PACKAGE",
        packageHours: option.hours,
        packageWorkshop: workshop,
        amountAgorot: option.priceAgorot,
        status: "PENDING",
        environment: environmentOf(provider),
        provider: provider.name,
        idempotencyKey,
      },
    }));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    payment = await prisma.payment.findUniqueOrThrow({ where: { idempotencyKey } });
    if (payment.userId !== userId || payment.purpose !== "PACKAGE" || payment.packageHours !== option.hours || payment.packageWorkshop !== workshop) {
      throw new PaymentFlowError("מפתח הבקשה כבר שימש לרכישה אחרת", "CONFLICT");
    }
  }

  if (payment.status !== "PENDING") {
    return {
      paymentId: payment.id,
      providerPaymentId: payment.providerPaymentId ?? undefined,
      hours: option.hours,
      workshop,
      amountAgorot: payment.amountAgorot,
      status: payment.status,
    };
  }

  // אידמפוטנטי מול הספק לפי אותו מפתח: קריסה לפני שמירת המזהה לא תיצור תשלום שני
  const requestInput = {
    amountAgorot: payment.amountAgorot,
    currency: "ILS" as const,
    description: `רכישת חבילת ${option.hours} שעות${workshop ? " (חדר סדנאות)" : ""}`,
    idempotencyKey: payment.idempotencyKey,
    customerRef: userId,
    metadata: { packageHours: String(option.hours), ...(workshop ? { packageWorkshop: "true" } : {}) } as Record<string, string>,
  };
  const request = await timeStep("provider", () => provider.createPaymentRequest(requestInput));
  if (!payment.providerPaymentId) {
    const paymentId = payment.id;
    await timeStep("db.save", async () => {
      await prisma.payment.updateMany({
        where: { id: paymentId, providerPaymentId: null },
        data: { providerPaymentId: request.providerPaymentId },
      });
      await audit(paymentId, "create", "ok");
    });
  }
  return {
    paymentId: payment.id,
    providerPaymentId: request.providerPaymentId,
    checkoutUrl: request.checkoutUrl,
    hours: option.hours,
    workshop,
    amountAgorot: payment.amountAgorot,
    status: payment.status,
  };
}

export type PackageFinalizeOutcome =
  | "PACKAGE_ACTIVATED"
  | "ALREADY_ACTIVATED"
  | "PENDING"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED"
  | "AMOUNT_MISMATCH"
  /** תשלום שדורש בדיקה ידנית (שולם אחרי ביטול, או נמצאה עסקת החזר): החבילה לא הופעלה, החריגה תועדה והנהלה קיבלה התראה */
  | "PAYMENT_REVIEW";

/**
 * ההחלטה מה לעשות בתשובת אימות מהספק, לפי המצב השמור של הרכישה. פונקציה טהורה (בלי מסד), כדי שכל צירוף ייבדק.
 *
 *  - עסקת החזר אצל הספק (קוד 6 ב-Grow, או סכום שהוחזר): לעולם לא מפעילים אוטומטית, גם אם יש בקישור עסקה ששולמה
 *    (הצלחה היסטורית של עסקה שהוחזרה אינה הוכחת תשלום). חריגה לטיפול ידני (REVIEW_REFUNDED).
 *  - רכישה שבוטלה (CANCELLED) לעולם אינה מופעלת אוטומטית. אם התברר ששולמה: חריגה לטיפול ידני (REVIEW).
 *  - רכישה שנכשלה (FAILED) אינה סגורה לצמיתות: אם התברר שבסוף שולמה בסכום הנכון, היא מופעלת. (כישלון של ניסיון
 *    אחד אינו סופי, כי קישור התשלום נשאר פתוח לניסיון נוסף)
 *  - יותר מעסקה אחת ששולמה: מפעילים פעם אחת בלבד ומתעדים חריגה (MULTIPLE_PAID).
 *  - סכום שאינו תואם לעולם אינו מופעל.
 */
export type PackageVerificationDecision =
  | { action: "ACTIVATE"; multiplePaid: boolean }
  | { action: "REVIEW_PAID_AFTER_CANCEL" }
  | { action: "REVIEW_REFUNDED" }
  | { action: "MARK"; status: "FAILED" | "CANCELLED"; failureCode?: string }
  | { action: "RETURN"; outcome: "PENDING" | "PAYMENT_FAILED" | "PAYMENT_CANCELLED" | "AMOUNT_MISMATCH" };

export function decidePackageVerification(
  paymentStatus: "PENDING" | "FAILED" | "CANCELLED",
  expectedAgorot: number,
  verified: Pick<VerifiedPaymentStatus, "status" | "amountAgorot" | "failureCode" | "paidTransactions" | "refundObserved"> & {
    refundedAgorot?: number;
  }
): PackageVerificationDecision {
  if (verified.refundObserved || (verified.refundedAgorot ?? 0) > 0) return { action: "REVIEW_REFUNDED" };
  const keep = (): PackageVerificationDecision => ({
    action: "RETURN",
    outcome: paymentStatus === "FAILED" ? "PAYMENT_FAILED" : paymentStatus === "CANCELLED" ? "PAYMENT_CANCELLED" : "PENDING",
  });
  if (verified.status === "SUCCEEDED") {
    if (paymentStatus === "CANCELLED") return { action: "REVIEW_PAID_AFTER_CANCEL" };
    if (verified.amountAgorot !== expectedAgorot) return { action: "RETURN", outcome: "AMOUNT_MISMATCH" };
    return { action: "ACTIVATE", multiplePaid: (verified.paidTransactions?.length ?? 1) > 1 };
  }
  if (paymentStatus !== "PENDING") return keep();
  if (verified.amountAgorot !== expectedAgorot) return { action: "RETURN", outcome: "AMOUNT_MISMATCH" };
  if (verified.status === "FAILED" || verified.status === "CANCELLED") {
    return { action: "MARK", status: verified.status, failureCode: verified.failureCode };
  }
  return keep();
}

export interface PackageFinalizeResult {
  outcome: PackageFinalizeOutcome;
  paymentId: string;
  packageId?: string;
}

/**
 * מאמת תשלום רכישה מול הספק ומפעיל את החבילה. אידמפוטנטי ובטוח להרצה מקבילית: HoursPackage.paymentId ייחודי,
 * ושורת התשלום נעולה, ולכן אותו תשלום לא ייצור שתי חבילות.
 */
export async function finalizePackagePayment(params: {
  paymentId: string;
  provider: PaymentProvider;
  now?: Date;
  /**
   * בדיקה חוזרת גם אחרי שהחבילה כבר הופעלה, כדי לזהות חיוב נוסף על אותה רכישה (חריגה בלבד, לעולם לא זיכוי נוסף).
   * מופעלת מהתראת שרת של הספק: כל התראה עשויה לבשר על עסקה חדשה
   */
  recheck?: boolean;
  /** נקודת הזרקה לבדיקות בלבד */
  beforeApply?: () => Promise<void>;
}): Promise<PackageFinalizeResult> {
  const { paymentId, provider, now = new Date(), recheck = false, beforeApply } = params;

  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { hoursPackage: true } });
  if (!payment || payment.purpose !== "PACKAGE") throw new PaymentFlowError("התשלום לא נמצא", "NOT_FOUND");
  if (payment.provider !== provider.name || payment.environment !== environmentOf(provider)) {
    throw new PaymentFlowError("התשלום אינו שייך לספק הנוכחי", "INVALID");
  }
  const result = (outcome: PackageFinalizeOutcome, packageId?: string): PackageFinalizeResult => ({
    outcome,
    paymentId: payment.id,
    packageId,
  });

  // המחיר נעול כבר ב-startPackagePurchase (payment.amountAgorot), ואינו נבדק כאן מחדש מול הקטלוג החי: הקטלוג
  // ניתן לעריכת מנהל בכל רגע, ותשלום שנפתח לפני שינוי מחיר חייב להמשיך ולהתממש באותו סכום שהלקוח אישר ושהספק
  // בפועל חייב (ראו ההשוואה ל-verified.amountAgorot להלן) — לא להיפסל רק בגלל שהמחיר בקטלוג כבר השתנה.
  // sanity קבוע: hours/amount חיוביים (payment.amountAgorot/packageHours נקבעים ע"י השרת בלבד ב-startPackagePurchase
  // ואינם ניתנים לשינוי אחרי כן, ולכן אינם יכולים "להידרדר" מהקטלוג)
  const hours = payment.packageHours;
  if (!hours || !Number.isInteger(payment.amountAgorot) || payment.amountAgorot <= 0) return result("AMOUNT_MISMATCH");

  const verify = async () => {
    const verified = await provider.getPaymentStatus(payment.providerPaymentId!);
    if (verified.providerPaymentId !== payment.providerPaymentId) {
      throw new PaymentFlowError("תשובת הספק אינה תואמת לתשלום", "INVALID");
    }
    return verified;
  };
  const paidOf = (v: VerifiedPaymentStatus): PaidTransaction[] => v.paidTransactions ?? [];
  const refundsOf = (v: VerifiedPaymentStatus): PaidTransaction[] =>
    v.refundTransactions?.length ? v.refundTransactions : [{ transactionId: "refund", amountAgorot: v.refundedAgorot }];
  const flag = async (kind: "MULTIPLE_PAID" | "PAID_AFTER_CANCEL" | "REFUNDED", transactions: PaidTransaction[]) => {
    const { created } = await recordPaymentAnomaly({ paymentId: payment.id, kind, transactions, environment: provider.environment, now });
    if (created) await audit(payment.id, "status", "error", `anomaly_${kind.toLowerCase()}`);
  };

  if (payment.hoursPackage) {
    // החבילה כבר הופעלה ולעולם לא תזוכה שוב. בהתראת ספק בודקים רק אם נוסף חיוב על אותה רכישה, כדי לסמן אותו לטיפול
    if (recheck && payment.providerPaymentId) {
      const verified = await verify();
      if (verified.status === "SUCCEEDED" && paidOf(verified).length > 1) await flag("MULTIPLE_PAID", paidOf(verified));
      // החזר אצל הספק על חבילה שכבר הופעלה: השעות לא יורדות אוטומטית, מסמנים לטיפול. החזר שהמערכת עצמה ביצעה (שורת
      // Refund במסד) אינו חריגה
      if ((verified.refundObserved || verified.refundedAgorot > 0) && (await prisma.refund.count({ where: { paymentId: payment.id } })) === 0) {
        await flag("REFUNDED", refundsOf(verified));
      }
    }
    return result("ALREADY_ACTIVATED", payment.hoursPackage.id);
  }
  if (!payment.providerPaymentId) return result("PENDING");

  // גם רכישה שנכשלה או בוטלה נבדקת שוב מול הספק: רכישה שנכשלה עשויה להיות משולמת בניסיון נוסף באותו קישור, ותשלום
  // על רכישה שבוטלה חייב להתגלות ולהיות מסומן לטיפול (בלי הפעלה אוטומטית)
  // העסקאות ששולמו לפי האימות הזה (ריק כשהספק אינו מדווח עליהן), והאם יש יותר מאחת
  let verifiedPaid: PaidTransaction[] = [];
  let multiplePaid = false;
  if (payment.status !== "SUCCEEDED") {
    const verified = await verify();
    const decision = decidePackageVerification(payment.status, payment.amountAgorot, verified);
    switch (decision.action) {
      case "REVIEW_REFUNDED":
        await flag("REFUNDED", refundsOf(verified));
        return result("PAYMENT_REVIEW");
      case "REVIEW_PAID_AFTER_CANCEL": {
        const paid = paidOf(verified);
        await flag("PAID_AFTER_CANCEL", paid.length > 0 ? paid : [{ transactionId: "unknown", amountAgorot: verified.amountAgorot }]);
        return result("PAYMENT_REVIEW");
      }
      case "MARK":
        await prisma.payment.updateMany({
          where: { id: payment.id, status: "PENDING" },
          data: { status: decision.status, failureCode: decision.failureCode ?? null },
        });
        await audit(payment.id, "status", "ok", decision.status.toLowerCase());
        return result(decision.status === "FAILED" ? "PAYMENT_FAILED" : "PAYMENT_CANCELLED");
      case "RETURN":
        if (decision.outcome === "AMOUNT_MISMATCH") await audit(payment.id, "status", "error", "amount_mismatch");
        return result(decision.outcome);
      case "ACTIVATE":
        if (payment.status === "FAILED") await audit(payment.id, "status", "ok", "late_success_after_failure");
        verifiedPaid = paidOf(verified);
        multiplePaid = decision.multiplePaid;
        break;
    }
  }

  await beforeApply?.();

  try {
    const pkg = await prisma.$transaction(async (tx) => {
      await lockPaymentRow(tx, payment.id);
      const existing = await tx.hoursPackage.findUnique({ where: { paymentId: payment.id } });
      if (existing) return { id: existing.id, created: false };
      // תחת נעילת השורה: רכישה שבוטלה בינתיים לעולם לא מופעלת אוטומטית
      const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } });
      if (current.status === "CANCELLED") return null;

      await tx.payment.updateMany({
        where: { id: payment.id, status: { not: "SUCCEEDED" } },
        data: { status: "SUCCEEDED", paidAt: now, failureCode: null },
      });
      const created = await tx.hoursPackage.create({
        data: {
          userId: payment.userId,
          hours,
          workshop: payment.packageWorkshop,
          pricePaidAgorot: payment.amountAgorot,
          minutesTotal: packageMinutes(hours),
          minutesRemaining: packageMinutes(hours),
          purchasedAt: now,
          expiresAt: packageExpiry(now),
          paymentId: payment.id,
        },
      });
      return { id: created.id, created: true };
    });
    if (!pkg) {
      await flag("PAID_AFTER_CANCEL", verifiedPaid.length > 0 ? verifiedPaid : [{ transactionId: "unknown", amountAgorot: payment.amountAgorot }]);
      return result("PAYMENT_REVIEW");
    }
    if (pkg.created) await audit(payment.id, "status", "ok", "package_activated");
    if (multiplePaid) await flag("MULTIPLE_PAID", verifiedPaid);
    return result(pkg.created ? "PACKAGE_ACTIVATED" : "ALREADY_ACTIVATED", pkg.id);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await prisma.hoursPackage.findUniqueOrThrow({ where: { paymentId: payment.id } });
    if (multiplePaid) await flag("MULTIPLE_PAID", verifiedPaid);
    return result("ALREADY_ACTIVATED", existing.id);
  }
}

// ───────────────────────────── בקשת ביטול חבילה ─────────────────────────────

const MAX_CANCELLATION_REASON = 500;

/**
 * לקוח מגיש בקשה לבטל חבילה. הבקשה אינה מבטלת את החבילה, אינה מנכה יתרה ואינה מבצעת החזר: היא נרשמת לטיפול מנהל
 * (שלב H) בהתאם למדיניות ולדין. לכל חבילה לכל היותר בקשה פתוחה אחת (אינדקס ייחודי חלקי במסד, בטוח גם במקביל).
 * הבקשה נרשמת על שם המשתמש המחובר בלבד ורק לחבילה שבבעלותו.
 */
export async function requestPackageCancellation(params: {
  userId: string;
  packageId: string;
  reason?: string;
  now?: Date;
}) {
  const { userId, packageId, now = new Date() } = params;
  const reason = params.reason?.trim().slice(0, MAX_CANCELLATION_REASON) || null;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "CLIENT") throw new PaymentFlowError("רק לקוח רשאי להגיש בקשה", "FORBIDDEN");

  // מסתירים קיום חבילה של אחרים
  const pkg = await prisma.hoursPackage.findFirst({ where: { id: packageId, userId } });
  if (!pkg) throw new PaymentFlowError("החבילה לא נמצאה", "NOT_FOUND");
  if (pkg.expiresAt.getTime() <= now.getTime() || pkg.minutesRemaining <= 0) {
    throw new PaymentFlowError("ניתן להגיש בקשת ביטול רק לחבילה פעילה שנותרה בה יתרה", "INVALID");
  }
  const approved = await prisma.packageCancellationRequest.count({ where: { packageId, status: "APPROVED" } });
  if (approved > 0) throw new PaymentFlowError("בקשת הביטול לחבילה זו כבר אושרה", "CONFLICT");

  try {
    const request = await prisma.packageCancellationRequest.create({ data: { packageId, userId, reason } });
    return { id: request.id, status: request.status, createdAt: request.createdAt };
  } catch (err) {
    if (isUniqueViolation(err)) throw new PaymentFlowError("כבר קיימת בקשת ביטול פתוחה לחבילה זו", "CONFLICT");
    throw err;
  }
}
