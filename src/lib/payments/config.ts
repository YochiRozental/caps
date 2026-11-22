import type { MockStore } from "@/lib/payments/mock-store";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { GROW_SANDBOX_BASE_URL, GrowPaymentProvider } from "@/lib/payments/grow-provider";
import { isStagingGateActive } from "@/lib/staging-gate/config";
import { MAKE_PROVIDER_VERIFICATION_READY, MIN_MAKE_API_KEY_LENGTH, MakeGrowPaymentProvider, isValidAllowedHost, parseAllowedHosts } from "@/lib/payments/make-provider";
import { PaymentConfigError, type PaymentProvider } from "@/lib/payments/provider";

/**
 * בחירת ספק הסליקה לפי משתני סביבה. ברירת המחדל היא "אין ספק": בלי הגדרה מפורשת אין תשלומים.
 *
 * הפרדת Mock מסליקה אמיתית אינה נשענת על NODE_ENV בלבד. Mock עולה רק אם כל התנאים מתקיימים:
 *   1. PAYMENT_PROVIDER=mock
 *   2. PAYMENT_ENVIRONMENT=sandbox (הצהרה מפורשת שזו סביבת בדיקות)
 *   3. PAYMENT_MOCK_ENABLED=true (דגל נפרד, כדי ששינוי תצורה אחד לא יפעיל אותו בטעות)
 *   4. NODE_ENV אינו production
 *   5. DATABASE_URL מצביע למסד מקומי (כך Mock לא יכול לעבוד מול מסד חי כמו Neon)
 *   6. PAYMENT_WEBHOOK_SECRET מוגדר
 *
 * חריג מפורש לשלב הפיתוח: PAYMENT_MOCK_ALLOW_DEPLOYED=true מבטל את תנאים 4 ו-5, כדי שאפשר יהיה להריץ את ההדגמה על אתר
 * מותקן (שרת + מסד מרוחק) כל עוד אין בו לקוחות או כסף אמיתיים. חובה להסיר אותו לפני שמחברים סליקה אמיתית או מקבלים לקוחות.
 */

export interface PaymentEnv {
  NODE_ENV?: string;
  PAYMENT_PROVIDER?: string;
  PAYMENT_ENVIRONMENT?: string;
  PAYMENT_MOCK_ENABLED?: string;
  PAYMENT_MOCK_ALLOW_DEPLOYED?: string;
  PAYMENT_MOCK_TEST_USERS?: string;
  PAYMENT_WEBHOOK_SECRET?: string;
  DATABASE_URL?: string;
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
  /** נקראים ע"י שער ה-Staging: ספק Make עולה רק כששער Staging פעיל */
  STAGING_GATE_ENABLED?: string;
  STAGING_GATE_PASSWORD?: string;
  STAGING_GATE_EXTRA_HOSTS?: string;
  RENDER_EXTERNAL_HOSTNAME?: string;
}

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MIN_WEBHOOK_SECRET_LENGTH = 16;

export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_DB_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function assertMockAllowed(env: PaymentEnv) {
  const problems: string[] = [];
  if (env.PAYMENT_ENVIRONMENT !== "sandbox") problems.push("PAYMENT_ENVIRONMENT חייב להיות sandbox");
  if (env.PAYMENT_MOCK_ENABLED !== "true") problems.push("PAYMENT_MOCK_ENABLED חייב להיות true");
  if (env.PAYMENT_MOCK_ALLOW_DEPLOYED !== "true") {
    if (env.NODE_ENV === "production") problems.push("אסור בבניית production");
    if (!isLocalDatabaseUrl(env.DATABASE_URL)) problems.push("DATABASE_URL חייב להצביע למסד מקומי");
  }
  if (!env.PAYMENT_WEBHOOK_SECRET || env.PAYMENT_WEBHOOK_SECRET.length < MIN_WEBHOOK_SECRET_LENGTH) {
    problems.push(`PAYMENT_WEBHOOK_SECRET חסר או קצר מ-${MIN_WEBHOOK_SECRET_LENGTH} תווים`);
  }
  if (problems.length > 0) {
    // ההודעה כוללת רק שמות משתנים ולא ערכים (בלי חשיפת סודות או כתובת מסד)
    throw new PaymentConfigError(`ספק התשלום המדומה (mock) חסום: ${problems.join("; ")}`);
  }
}

/** מחזיר את הספק המוגדר, או זורק PaymentConfigError. אין יצירה אוטומטית של Mock */
export function getPaymentProvider(
  env: PaymentEnv = process.env,
  options: { mockStore?: MockStore; mockCustomerAllowed?: (customerRef: string) => Promise<boolean> } = {}
): PaymentProvider {
  const kind = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "none") {
    throw new PaymentConfigError("לא הוגדר ספק תשלומים (PAYMENT_PROVIDER)");
  }
  if (kind === "mock") {
    assertMockAllowed(env);
    // באתר מותקן (PAYMENT_MOCK_ALLOW_DEPLOYED) תשלומי דמה מוגבלים למשתמשי בדיקה מורשים; בהדגמה מקומית אין הגבלה
    return new MockPaymentProvider(env.PAYMENT_WEBHOOK_SECRET!, options.mockStore, env.PAYMENT_MOCK_ALLOW_DEPLOYED === "true" ? options.mockCustomerAllowed : undefined);
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
  if (!MAKE_PROVIDER_VERIFICATION_READY) problems.push("אימות עסקאות דרך Make טרם מומש (MAKE_PROVIDER_VERIFICATION_READY=false)");
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
  if (problems.length > 0) throw new PaymentConfigError(`ספק Make חסום: ${problems.join("; ")}`);
  return new MakeGrowPaymentProvider({
    webhookUrl: env.MAKE_PAYMENT_WEBHOOK_URL!,
    apiKey: env.MAKE_PAYMENT_API_KEY!,
    environment: "sandbox",
    allowedCheckoutHosts: checkoutHosts,
    verify: { webhookUrl: env.MAKE_VERIFY_WEBHOOK_URL!, apiKey: env.MAKE_VERIFY_API_KEY! },
    returnBaseUrl: env.MAKE_PAYMENT_RETURN_BASE_URL!,
  });
}
