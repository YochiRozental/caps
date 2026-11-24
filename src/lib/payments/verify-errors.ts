import {
  IdempotencyConflictError,
  PaymentConfigError,
  PaymentError,
  PaymentStateError,
  WebhookVerificationError,
} from "@/lib/payments/provider";

/**
 * כשל זמני באימות מול הספק (Make לא זמין, תרחיש כבוי, מפתח שגוי, תשובה לא תקינה). זה לא "התשלום נכשל": התשלום
 * עשוי להיות שולם, והוא נשאר PENDING בשרת עד שאימות אמיתי יצליח. לא מאשרים ולא דוחים בגללו.
 * שגיאות עם משמעות עסקית (מצב, אידמפוטנטיות, חתימה, תצורה) אינן נכללות כאן.
 */
export function isTransientVerifyFailure(err: unknown): err is PaymentError {
  return (
    err instanceof PaymentError &&
    !(err instanceof PaymentStateError) &&
    !(err instanceof IdempotencyConflictError) &&
    !(err instanceof WebhookVerificationError) &&
    !(err instanceof PaymentConfigError)
  );
}

export const VERIFY_UNAVAILABLE_CODE = "VERIFY_UNAVAILABLE";

export const VERIFY_UNAVAILABLE_MESSAGE =
  "לא ניתן לאמת כרגע את התשלום מול Grow (תקלה זמנית). התשלום לא אבד ואין לשלם שוב: המערכת תמשיך לנסות, והחבילה תופעל ברגע שהאימות יצליח.";

/**
 * שורת לוג בטוחה: הודעות PaymentError נכתבות בקוד שלנו ואינן כוללות כתובות, מפתחות או טוקנים (ראו make-provider).
 * שם המחלקה אינו שימושי בייצור (מכווץ ל-"t"), ולכן נרשמת ההודעה. מוגבלת באורך ליתר ביטחון.
 */
export function verifyFailureLogLine(err: PaymentError, paymentId: string): string {
  return `[payments] verify unavailable payment=${paymentId}: ${err.message.slice(0, 200)}`;
}
