import { getPaymentProvider } from "@/lib/payments/config";
import { PaymentConfigError, type PaymentProvider } from "@/lib/payments/provider";

/**
 * בניית ספק התשלום הפעיל, ללא תלות ב-Next.js או ב-Auth.js, כדי שגם שרת ה-IVR (תהליך Node נפרד) ישתמש באותו ספק ובאותן
 * הגנות. מחזיר null כשאין ספק תקף (ברירת המחדל). הספקים היחידים הם Grow ו-Make (ראו config.ts).
 */
export function getRuntimeProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider | null {
  try {
    return getPaymentProvider(env);
  } catch (err) {
    if (err instanceof PaymentConfigError) return null;
    throw err;
  }
}
