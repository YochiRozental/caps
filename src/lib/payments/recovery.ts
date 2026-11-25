import { prisma } from "@/lib/prisma";
import { finalizePayment } from "@/lib/payments/booking-payment";
import { PrismaMockStore, type MockStore } from "@/lib/payments/mock-store";
import type { PaymentProvider, PaymentRequestResult } from "@/lib/payments/provider";
import { environmentOf } from "@/lib/payments/shared";
import { isTransientVerifyFailure } from "@/lib/payments/verify-errors";

/**
 * התאוששות בצד השרת לתשלומים שנשארו ממתינים: הלקוח שילם וסגר את האתר, וההתראה מ-Grow לא הגיעה או נכשלה.
 * מופעל מנקודת קצה מוגנת (POST /api/cron/payment-recovery) על ידי מתזמן חיצוני. אין כאן לוגיקת אימות חדשה:
 * כל תשלום עובר את finalizePayment הקיים - אותו מסלול כמו התראה או בדיקה מהדפדפן (אימות מול Grow דרך תרחיש
 * האימות של המסלול שבו התשלום נוצר, link או process, השוואת סכום, שיוך עסקה לרכישה אחת, זיכוי חד-פעמי).
 *
 * חיסכון בפעולות Make: רק תשלומים בני 2 דקות עד 48 שעות, ועם השהיה שגדלה עם הגיל (כרבע מגיל התשלום, בין 5 דקות
 * ל-6 שעות), כך שתשלום נטוש נבדק כ-20 פעמים בסך הכול ולא בכל ריצה. סימני הבדיקה נשמרים בטבלת ה-KV הקיימת
 * (MockProviderRecord), בלי מיגרציה.
 *
 * לא יוצרים כאן קישורי תשלום: תשלום בלי מזהה ספק מתואם רק אם הספק מוצא בקשה קיימת לפי מפתח ה-idempotency בלי פנייה
 * לרשת (findExistingPaymentRequest). אחרת הוא נשאר כפי שהוא. חיובי כרטיס שמור אינם בתחום (ראו reconcilePendingPayments).
 */

export const RECOVERY_MIN_AGE_MS = 2 * 60 * 1000;
export const RECOVERY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const SCAN_FACTOR = 5;

/** מתי מותר לבדוק שוב תשלום בגיל הזה: כרבע מגילו, בין 5 דקות ל-6 שעות */
export function recheckIntervalMs(ageMs: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(ageMs / 4)));
}

export interface RecoveryCandidate {
  id: string;
  createdAt: Date;
  providerPaymentId: string | null;
  idempotencyKey: string;
}

export interface RecoverySummary {
  /** תשלומים ממתינים בחלון הזמן (עד מגבלת הסריקה) */
  scanned: number;
  /** נבדקו מול הספק בריצה הזו */
  checked: number;
  /** לא הגיע זמנם לפי ההשהיה */
  skippedBackoff: number;
  /** אין מזהה ספק ואין בקשה קיימת לשחזר ממנה (לא נוצר קישור חדש) */
  skippedNoRef: number;
  /** תוצאות finalize לפי outcome (למשל PACKAGE_ACTIVATED, CONFIRMED, PENDING) */
  outcomes: Record<string, number>;
  /** אימות לא זמין זמנית (Make/Grow): ייבדק שוב בריצה הבאה לפי ההשהיה */
  transientFailures: number;
  /** שגיאות אחרות (שם המחלקה בלבד) */
  errors: number;
}

export interface RecoveryDeps {
  listCandidates(args: { from: Date; to: Date; take: number }): Promise<RecoveryCandidate[]>;
  finalize(paymentId: string): Promise<{ outcome: string }>;
  /** שומר מזהה ספק רק אם עדיין חסר (אותו תנאי כמו ביצירה) */
  attachProviderRef(paymentId: string, providerPaymentId: string): Promise<void>;
  store: MockStore;
}

type RecoveryProvider = PaymentProvider & {
  findExistingPaymentRequest?(idempotencyKey: string): Promise<PaymentRequestResult | null>;
};

const markKey = (paymentId: string) => `recovery-checked:${paymentId}`;

export function defaultRecoveryDeps(provider: PaymentProvider, now: Date): RecoveryDeps {
  return {
    listCandidates: ({ from, to, take }) =>
      prisma.payment.findMany({
        where: {
          purpose: { in: ["BOOKING", "PACKAGE"] },
          status: "PENDING",
          provider: provider.name,
          environment: environmentOf(provider),
          // חיוב כרטיס שמור (paymentMethodId) אינו דף תשלום מתארח: מטופל בנפרד ואינו נבדק כאן
          paymentMethodId: null,
          createdAt: { gte: from, lte: to },
        },
        select: { id: true, createdAt: true, providerPaymentId: true, idempotencyKey: true },
        // החדשים קודם: הסיכוי שלקוח שילם עכשיו וממתין להפעלה גבוה יותר
        orderBy: { createdAt: "desc" },
        take,
      }),
    finalize: (paymentId) => finalizePayment({ paymentId, provider, now }),
    attachProviderRef: async (paymentId, providerPaymentId) => {
      await prisma.payment.updateMany({ where: { id: paymentId, providerPaymentId: null }, data: { providerPaymentId } });
    },
    store: new PrismaMockStore(prisma),
  };
}

export async function runPaymentRecovery(params: {
  provider: PaymentProvider;
  now?: Date;
  limit?: number;
  deps?: RecoveryDeps;
}): Promise<RecoverySummary> {
  const now = params.now ?? new Date();
  const limit = params.limit ?? DEFAULT_LIMIT;
  const provider = params.provider as RecoveryProvider;
  const deps = params.deps ?? defaultRecoveryDeps(provider, now);
  const nowMs = now.getTime();

  const summary: RecoverySummary = { scanned: 0, checked: 0, skippedBackoff: 0, skippedNoRef: 0, outcomes: {}, transientFailures: 0, errors: 0 };
  const candidates = await deps.listCandidates({
    from: new Date(nowMs - RECOVERY_MAX_AGE_MS),
    to: new Date(nowMs - RECOVERY_MIN_AGE_MS),
    take: limit * SCAN_FACTOR,
  });
  summary.scanned = candidates.length;

  for (const c of candidates) {
    if (summary.checked >= limit) break;
    const ageMs = nowMs - c.createdAt.getTime();
    const mark = await deps.store.get<{ at: number }>(markKey(c.id));
    if (mark && nowMs - mark.at < recheckIntervalMs(ageMs)) {
      summary.skippedBackoff++;
      continue;
    }

    let providerPaymentId = c.providerPaymentId;
    if (!providerPaymentId) {
      // אין מזהה ספק (קריסה בין תשובת הספק לשמירה): מחפשים בקשה קיימת בלי לפנות לרשת ובלי ליצור קישור חדש
      const existing = provider.findExistingPaymentRequest ? await provider.findExistingPaymentRequest(c.idempotencyKey) : null;
      if (!existing) {
        summary.skippedNoRef++;
        continue;
      }
      await deps.attachProviderRef(c.id, existing.providerPaymentId);
      providerPaymentId = existing.providerPaymentId;
    }

    // הסימון נשמר לפני האימות: גם כשל (Make לא זמין) נכנס להשהיה, כדי שתקלה ממושכת לא תגרום לבדיקות חוזרות בכל ריצה
    await deps.store.put(markKey(c.id), { at: nowMs });
    summary.checked++;
    try {
      const result = await deps.finalize(c.id);
      summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
    } catch (err) {
      if (isTransientVerifyFailure(err)) summary.transientFailures++;
      else summary.errors++;
    }
  }
  return summary;
}

/** שורת לוג אחת לריצה: מספרים בלבד, בלי מזהי תשלום, משתמשים או סכומים */
export function recoveryLogLine(s: RecoverySummary, ms: number): string {
  const outcomes = Object.entries(s.outcomes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  return `[payments] recovery scanned=${s.scanned} checked=${s.checked} backoff=${s.skippedBackoff} noRef=${s.skippedNoRef} transient=${s.transientFailures} errors=${s.errors} outcomes=${outcomes || "-"} ms=${Math.round(ms)}`;
}
