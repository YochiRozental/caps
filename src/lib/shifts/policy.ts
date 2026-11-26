/**
 * מדיניות משמרות קבועות: מקום אחד לכל הקבועים העסקיים, כדי שאפשר יהיה לשנות אותם בעתיד בלי לחפש בקוד.
 */

/** תקופת חסד אחרי שתשלום ידני לא התקבל במועדו: המשמרת נשארת פעילה. בתומה, אם החוב לא הוסדר, המשמרת עוברת ל-SUSPENDED */
export const SHIFT_GRACE_DAYS = 7;

/** ריצת Cron שנתקעה ב-RUNNING יותר מזה נחשבת נטושה, וריצה חדשה רשאית לקחת את מקומה */
export const CRON_STALE_RUN_MS = 30 * 60_000;

export const SHIFT_BILLING_JOB = "shift-billing";

/** תוקף זיכוי שעות חלופיות אחרי סגירה ביוזמת ההנהלה (ימים מרגע מתן הזיכוי) */
export const MAKEUP_CREDIT_VALIDITY_DAYS = 90;

/** תקרות בטיחות לגודל בקשות */
export const MAX_REASON_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;

/** כמה משמרות פעילות/ממתינות מותרות ללקוח אחד בו-זמנית (מונע נעילת חדרים בהיקף חריג) */
export const MAX_OPEN_SHIFTS_PER_USER = 4;
