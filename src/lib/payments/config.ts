import { GROW_SANDBOX_BASE_URL, GrowPaymentProvider } from "@/lib/payments/grow-provider";
import { isStagingGateActive } from "@/lib/staging-gate/config";
import {
  MIN_MAKE_API_KEY_LENGTH,
  isMakeVerificationReady,
  MakeGrowPaymentProvider,
  isValidAllowedHost,
  parseAllowedHosts,
  type MakeCheckoutFlow,
} from "@/lib/payments/make-provider";
import { PaymentConfigError, type PaymentProvider } from "@/lib/payments/provider";

/**
 * בחירת ספק הסליקה לפי משתני סביבה. ברירת המחדל היא "אין ספק": בלי הגדרה מפורשת אין תשלומים.
 * התשלום מתבצע תמיד בדף המאובטח של Grow (ישירות, או דרך תרחישי Make). אין באתר ספק מדומה, כרטיס שמור או חיוב טוקן.
 */

export interface PaymentEnv {
  NODE_ENV?: string;
  PAYMENT_PROVIDER?: string;
  PAYMENT_ENVIRONMENT?: string;
  GROW_USER_ID?: string;
  GROW_PAGE_CODE?: string;
  GROW_API_BASE_URL?: string;
  GROW_SUCCESS_URL?: string;
  GROW_CANCEL_URL?: string;
  GROW_NOTIFY_URL?: string;
  /** חריג מפורש ויחיד שמתיר Grow ב-live. ללא זה, ספק Grow עולה רק בסביבת sandbox (שלב זה: Sandbox בלבד) */
  GROW_ALLOW_LIVE?: string;
  /** ספק Make (Make -> Grow Sandbox): כתובת ה-Custom webhook ומפתח x-make-apikey. סודות - לא נרשמים בלוגים */
  MAKE_PAYMENT_WEBHOOK_URL?: string;
  MAKE_PAYMENT_API_KEY?: string;
  /** דומייני checkout מאושרים של Grow (מופרדים בפסיקים). חובה, בלי ברירת מחדל */
  MAKE_PAYMENT_CHECKOUT_HOSTS?: string;
  /** תרחיש האימות (Get Payment Link Info) ובסיס כתובת ההחזרה של האתר (HTTPS) */
  MAKE_VERIFY_WEBHOOK_URL?: string;
  MAKE_VERIFY_API_KEY?: string;
  MAKE_PAYMENT_RETURN_BASE_URL?: string;
  /** אופציונלי: תרחיש Make שמבצע approveTransaction ב-Grow אחרי התראת שרת. בלעדיו ההתראה עדיין מפעילה חבילה */
  MAKE_APPROVE_WEBHOOK_URL?: string;
  MAKE_APPROVE_API_KEY?: string;
  /**
   * מסלול יצירת דף התשלום לתשלומים חדשים: "link" (ברירת מחדל, Create Payment Link) או "process" (createPaymentProcess
   * דרך תרחישי Make ייעודיים, לדף שניתן להטמיע ב-iframe). "process" דורש את ארבעת משתני MAKE_PROCESS_*
   */
  MAKE_PAYMENT_FLOW?: string;
  MAKE_PROCESS_WEBHOOK_URL?: string;
  MAKE_PROCESS_API_KEY?: string;
  MAKE_PROCESS_VERIFY_WEBHOOK_URL?: string;
  MAKE_PROCESS_VERIFY_API_KEY?: string;
  /** true רק ב-Staging, אחרי שתרחיש האימות נבדק מול Grow Sandbox. בלי זה ספק Make חסום */
  MAKE_VERIFICATION_CONFIRMED?: string;
  /** נקראים ע"י שער ה-Staging: ספק Make עולה רק כששער Staging פעיל */
  STAGING_GATE_ENABLED?: string;
  STAGING_GATE_PASSWORD?: string;
  STAGING_GATE_EXTRA_HOSTS?: string;
  RENDER_EXTERNAL_HOSTNAME?: string;
}

/**
 * מחזיר את הספק המוגדר, או זורק PaymentConfigError. הספקים היחידים: grow ו-make (Grow דרך Make). אין ספק מדומה באתר:
 * "mock" אינו ערך מוכר, וספק הבדיקות (src/lib/payments/testing) זמין רק לבדיקות האוטומטיות.
 */
export function getPaymentProvider(env: PaymentEnv = process.env): PaymentProvider {
  const kind = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "none") {
    throw new PaymentConfigError("לא הוגדר ספק תשלומים (PAYMENT_PROVIDER)");
  }
  if (kind === "grow") {
    return buildGrowProvider(env);
  }
  if (kind === "make") {
    return buildMakeProvider(env);
  }
  throw new PaymentConfigError(`ספק תשלומים לא מוכר: ${kind}`);
}

/**
 * ספק Grow (Meshulam), שלב Sandbox בלבד. חסימת Production מפורשת (לא נגזרת מ-NODE_ENV): Grow עולה ב-live רק עם
 * GROW_ALLOW_LIVE=true, ואין היום נתיב שמגדיר אותו - המימוש הנוכחי טרם אומת מול Sandbox אמיתי (ראו דוח ההיתכנות).
 */
function buildGrowProvider(env: PaymentEnv): PaymentProvider {
  const problems: string[] = [];
  if (!env.GROW_USER_ID) problems.push("GROW_USER_ID חסר");
  if (!env.GROW_PAGE_CODE) problems.push("GROW_PAGE_CODE חסר");
  if (!env.GROW_SUCCESS_URL) problems.push("GROW_SUCCESS_URL חסר");
  if (!env.GROW_CANCEL_URL) problems.push("GROW_CANCEL_URL חסר");
  if (env.PAYMENT_ENVIRONMENT !== "sandbox" && env.GROW_ALLOW_LIVE !== "true") {
    problems.push("ספק Grow חסום מחוץ ל-sandbox בשלב זה (PAYMENT_ENVIRONMENT=sandbox, או GROW_ALLOW_LIVE=true לאחר בדיקה מלאה)");
  }
  if (env.PAYMENT_ENVIRONMENT !== "sandbox" && !env.GROW_API_BASE_URL) {
    // כתובת ה-Base ל-Production לא מתועדת כקבוע ידוע; אין ברירת מחדל - חייבים לקבוע אותה במפורש
    problems.push("GROW_API_BASE_URL חסר (נדרש במפורש מחוץ ל-sandbox)");
  }
  if (problems.length > 0) {
    throw new PaymentConfigError(`ספק Grow חסום: ${problems.join("; ")}`);
  }
  return new GrowPaymentProvider({
    userId: env.GROW_USER_ID!,
    pageCode: env.GROW_PAGE_CODE!,
    apiBaseUrl: env.GROW_API_BASE_URL || (env.PAYMENT_ENVIRONMENT === "sandbox" ? GROW_SANDBOX_BASE_URL : ""),
    environment: env.PAYMENT_ENVIRONMENT === "live" ? "live" : "sandbox",
    successUrl: env.GROW_SUCCESS_URL!,
    cancelUrl: env.GROW_CANCEL_URL!,
    notifyUrl: env.GROW_NOTIFY_URL,
  });
}

/**
 * ספק Make, Sandbox בלבד. חסום תמיד כל עוד MAKE_PROVIDER_VERIFICATION_READY=false: אין עדיין אימות עסקאות אמין
 * דרך Make, ולכן אסור להפעיל אותו (גם אם כל המשתנים תקינים). ההודעות כוללות שמות משתנים בלבד, לא ערכים.
 */
function buildMakeProvider(env: PaymentEnv): PaymentProvider {
  const problems: string[] = [];
  if (!isMakeVerificationReady(env as Record<string, string | undefined>)) problems.push("אימות עסקאות דרך Make טרם אושר (VERIFICATION_READY: יש להגדיר MAKE_VERIFICATION_CONFIRMED=true ב-Staging בלבד, אחרי בדיקת תרחיש האימות)");
  if (env.PAYMENT_ENVIRONMENT !== "sandbox") problems.push("PAYMENT_ENVIRONMENT חייב להיות sandbox");
  let httpsOk = false;
  try {
    httpsOk = !!env.MAKE_PAYMENT_WEBHOOK_URL && new URL(env.MAKE_PAYMENT_WEBHOOK_URL).protocol === "https:";
  } catch {
    httpsOk = false;
  }
  if (!httpsOk) problems.push("MAKE_PAYMENT_WEBHOOK_URL חסר או אינו HTTPS");
  if (!env.MAKE_PAYMENT_API_KEY || env.MAKE_PAYMENT_API_KEY.length < MIN_MAKE_API_KEY_LENGTH) {
    problems.push(`MAKE_PAYMENT_API_KEY חסר או קצר מ-${MIN_MAKE_API_KEY_LENGTH} תווים`);
  }
  // ספק Make רק ב-Staging (שער פעיל ומארח Render מוכר כלא-Production): לעולם לא בסביבה חיה
  if (!isStagingGateActive("", env)) problems.push("ספק Make מותר רק בסביבת Staging עם שער Staging פעיל");
  const isHttpsUrl = (v: string | undefined) => {
    try {
      return !!v && new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  };
  if (!isHttpsUrl(env.MAKE_VERIFY_WEBHOOK_URL)) problems.push("MAKE_VERIFY_WEBHOOK_URL חסר או אינו HTTPS");
  if (!env.MAKE_VERIFY_API_KEY || env.MAKE_VERIFY_API_KEY.length < MIN_MAKE_API_KEY_LENGTH) {
    problems.push(`MAKE_VERIFY_API_KEY חסר או קצר מ-${MIN_MAKE_API_KEY_LENGTH} תווים`);
  }
  if (!isHttpsUrl(env.MAKE_PAYMENT_RETURN_BASE_URL)) problems.push("MAKE_PAYMENT_RETURN_BASE_URL חסר או אינו HTTPS");
  const checkoutHosts = parseAllowedHosts(env.MAKE_PAYMENT_CHECKOUT_HOSTS);
  if (checkoutHosts.length === 0 || !checkoutHosts.every(isValidAllowedHost)) problems.push("MAKE_PAYMENT_CHECKOUT_HOSTS חסר או לא תקין");

  // מסלול Payment Process: אופציונלי וכבוי כברירת מחדל. אם התרחישים מוגדרים במלואם הם נטענים גם במסלול "link",
  // כדי שתשלומי process פתוחים ימשיכו להתאמת אחרי חזרה למסלול הקישורים
  const flowRaw = (env.MAKE_PAYMENT_FLOW ?? "").trim().toLowerCase();
  if (flowRaw !== "" && flowRaw !== "link" && flowRaw !== "process") problems.push("MAKE_PAYMENT_FLOW חייב להיות link או process");
  const flow: MakeCheckoutFlow = flowRaw === "process" ? "process" : "link";
  const keyOk = (v: string | undefined) => (v?.length ?? 0) >= MIN_MAKE_API_KEY_LENGTH;
  const processVars = [env.MAKE_PROCESS_WEBHOOK_URL, env.MAKE_PROCESS_API_KEY, env.MAKE_PROCESS_VERIFY_WEBHOOK_URL, env.MAKE_PROCESS_VERIFY_API_KEY];
  const processComplete =
    isHttpsUrl(env.MAKE_PROCESS_WEBHOOK_URL) &&
    keyOk(env.MAKE_PROCESS_API_KEY) &&
    isHttpsUrl(env.MAKE_PROCESS_VERIFY_WEBHOOK_URL) &&
    keyOk(env.MAKE_PROCESS_VERIFY_API_KEY);
  // הגדרה חלקית היא כמעט תמיד טעות: חוסמים (כשל סגור) במקום להתעלם בשקט
  if (!processComplete && (flow === "process" || processVars.some(Boolean))) {
    problems.push("משתני MAKE_PROCESS_* חסרים, אינם HTTPS או שהמפתחות קצרים מדי");
  }
  if (problems.length > 0) throw new PaymentConfigError(`ספק Make חסום: ${problems.join("; ")}`);
  return new MakeGrowPaymentProvider({
    webhookUrl: env.MAKE_PAYMENT_WEBHOOK_URL!,
    apiKey: env.MAKE_PAYMENT_API_KEY!,
    environment: "sandbox",
    allowedCheckoutHosts: checkoutHosts,
    flow,
    process: processComplete
      ? {
          create: { webhookUrl: env.MAKE_PROCESS_WEBHOOK_URL!, apiKey: env.MAKE_PROCESS_API_KEY! },
          verify: { webhookUrl: env.MAKE_PROCESS_VERIFY_WEBHOOK_URL!, apiKey: env.MAKE_PROCESS_VERIFY_API_KEY! },
        }
      : undefined,
    verify: { webhookUrl: env.MAKE_VERIFY_WEBHOOK_URL!, apiKey: env.MAKE_VERIFY_API_KEY! },
    returnBaseUrl: env.MAKE_PAYMENT_RETURN_BASE_URL!,
    // תרחיש האישור (approveTransaction) אופציונלי: מוגדר רק אם שני המשתנים תקינים. אחרת מדלגים עליו בשקט
    approve:
      isHttpsUrl(env.MAKE_APPROVE_WEBHOOK_URL) && (env.MAKE_APPROVE_API_KEY?.length ?? 0) >= MIN_MAKE_API_KEY_LENGTH
        ? { webhookUrl: env.MAKE_APPROVE_WEBHOOK_URL!, apiKey: env.MAKE_APPROVE_API_KEY! }
        : undefined,
  });
}

/**
 * כשל סגור: אם PAYMENT_PROVIDER מצביע במפורש על ספק אמיתי (make/grow) אבל התצורה שגויה, getRuntimeProvider מחזיר null
 * והאתר היה מדלג בשקט על התשלום ומאשר הזמנה ישירה. כאן מזהים את המצב הזה כדי לחסום במקום לדלג. מחזיר הודעת בעיה
 * (שמות משתנים בלבד, בלי ערכים) או null אם אין בעיה/הספק אינו make/grow. none לא מושפע.
 */
export function getRealProviderConfigProblem(env: PaymentEnv = process.env): string | null {
  const kind = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (kind !== "make" && kind !== "grow") return null;
  try {
    getPaymentProvider(env);
    return null;
  } catch (err) {
    if (err instanceof PaymentConfigError) return err.message;
    throw err;
  }
}
