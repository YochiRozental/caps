/**
 * חוזה ספק הסליקה. הלוגיקה העסקית (הזמנות, חבילות, משמרות) מדברת רק עם הממשק הזה.
 * הממשק גנרי בכוונה: הוא לא משקף נקודות קצה או שדות של ספק מסוים. ממשק אמיתי (PAYME) ימופה אליו
 * רק אחרי שהיכולות שלו יאומתו בתיעוד הרשמי.
 *
 * כל הסכומים במספרים שלמים באגורות (ILS) כדי למנוע שגיאות עיגול.
 */

/** sandbox = בדיקות בלבד; live = סליקה אמיתית. נשמר גם על כל תשלום במסד, כדי ששורת בדיקות לעולם לא תיחשב אמיתית */
export type PaymentEnvironment = "sandbox" | "live";

export type ProviderPaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type ProviderRefundStatus = "SUCCEEDED" | "FAILED";

export interface CreatePaymentRequestInput {
  amountAgorot: number;
  currency: "ILS";
  description: string;
  /** מפתח למניעת חיוב כפול: אותה בקשה חוזרת מחזירה את אותה תוצאה ולא יוצרת תשלום נוסף */
  idempotencyKey: string;
  /** מזהה פנימי של הלקוח (לא פרטים אישיים) */
  customerRef: string;
  returnUrl?: string;
  metadata?: Record<string, string>;
}

export interface PaymentRequestResult {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  /** כתובת עמוד התשלום המאובטח של הספק (Hosted Checkout). פרטי כרטיס לא עוברים דרך המערכת שלנו */
  checkoutUrl?: string;
}

/** סטטוס תשלום שנשלף מהספק מצד השרת. זה המקור היחיד לאמת; הודעת הצלחה מהדפדפן לא נחשבת */
export interface VerifiedPaymentStatus {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  amountAgorot: number;
  refundedAgorot: number;
  failureCode?: string;
  /**
   * כל העסקאות ששולמו שהספק ראה עבור התשלום הזה (מזהה + סכום), כשהספק מסוגל לראות את כל הניסיונות. אופציונלי:
   * ספק שאינו ממלא את השדה נחשב כמי שראה עסקה אחת בלבד. יותר מעסקה אחת = חיוב מרובה, שמזכה פעם אחת ומסומן לטיפול.
   */
  paidTransactions?: PaidTransaction[];
  /**
   * הספק ראה עסקת החזר עבור התשלום (למשל החזר שבוצע ישירות במסוף הספק), גם אם הסכום לא ידוע. חוסם הפעלה אוטומטית
   * של מה שנרכש, כי הצלחה היסטורית של עסקה שהוחזרה אינה הוכחת תשלום
   */
  refundObserved?: boolean;
  /** עסקאות ההחזר שהספק ראה (מזהה + סכום), לתיעוד החריגה */
  refundTransactions?: PaidTransaction[];
}

export interface PaidTransaction {
  transactionId: string;
  amountAgorot: number;
}

export interface RefundInput {
  providerPaymentId: string;
  /** חסר = החזר מלא של היתרה שטרם הוחזרה */
  amountAgorot?: number;
  idempotencyKey: string;
  reason?: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: ProviderRefundStatus;
  amountAgorot: number;
}

export interface WebhookInput {
  /** גוף הבקשה הגולמי, בדיוק כפי שהתקבל (החתימה מחושבת עליו) */
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** פרמטרי הכתובת שאליה נשלחה ההתראה (לספק שחותם את כתובת ההתראה עצמה, כמו Make/Grow). אופציונלי */
  query?: Record<string, string>;
}

/** אירוע webhook שעבר אימות חתימה. הוא רק טריגר: את הסטטוס הסופי שולפים עם getPaymentStatus */
export interface PaymentWebhookEvent {
  /** מזהה האירוע אצל הספק, לצורך מניעת עיבוד כפול */
  eventId: string;
  type: "payment.updated" | "refund.updated";
  providerPaymentId: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly environment: PaymentEnvironment;

  createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestResult>;
  getPaymentStatus(providerPaymentId: string): Promise<VerifiedPaymentStatus>;
  cancelPayment(providerPaymentId: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** מאמת חתימה ומפרש את ההתראה. זורק WebhookVerificationError אם החתימה לא תקינה */
  parseWebhook(input: WebhookInput): Promise<PaymentWebhookEvent>;
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** תצורה חסרה או אסורה (למשל Grow ב-live בלי אישור מפורש) */
export class PaymentConfigError extends PaymentError {}

/** אותו מפתח Idempotency שימש לבקשה עם פרמטרים שונים */
export class IdempotencyConflictError extends PaymentError {}

export class WebhookVerificationError extends PaymentError {}

/** פעולה לא חוקית במצב הנוכחי של התשלום (החזר על תשלום שלא הצליח, חריגה מהסכום וכו') */
export class PaymentStateError extends PaymentError {}
