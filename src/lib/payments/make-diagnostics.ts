import { createHash } from "node:crypto";
import { agorotToShekels } from "@/lib/payments/grow-provider";
import { MAKE_API_KEY_HEADER, deriveMakePaymentId } from "@/lib/payments/make-provider";
import { isStagingGateActive, type StagingGateEnv } from "@/lib/staging-gate/config";

/**
 * כלי אבחון זמני לתקשורת אתר -> Make, למנהל בלבד ובסביבת Staging בלבד. אינו חלק מזרימת התשלום: לא יוצר Payment,
 * לא מאשר הזמנות או חבילות, לא נוגע במסד, ולא עובר דרך MakeGrowPaymentProvider או GrowPaymentProvider.
 *
 * עקרונות אבטחה:
 *  - הלקוח בוחר רק תרחיש מתוך רשימה סגורה. כתובת, כותרות וגוף נקבעים בשרת: הנתיב אינו יכול לשמש כ-HTTP proxy.
 *  - הכתובת והמפתח מגיעים מ-env בלבד, ולעולם לא מוחזרים: התוצאה כוללת קטגוריה, קוד HTTP, זמן, ושמות שדות בלבד.
 *  - הנתונים הם נתוני דמה קבועים, עם סימון diagnostic כדי שהתרחיש ב-Make יוכל לעצור לפני Grow (ראו הנחיות בדוח).
 */

export type DiagScenario = "create" | "verify";
export const DIAG_SCENARIOS: readonly DiagScenario[] = ["create", "verify"];

/**
 * SUCCESS: Make השיב JSON (מודול Webhook response הורץ). ACCEPTED_NO_RESPONSE: Make קלט את הבקשה (2xx) אך לא החזיר JSON -
 * ברירת המחדל של Make ("Accepted") כשאין Webhook response, וזו התוצאה הצפויה בגילוי שדות (Run once). NOT_LISTENING: 410,
 * אין תרחיש מאזין (לא במצב Run once ולא פעיל). AUTH_FAILED רק 401/403.
 */
export type DiagOutcome = "SUCCESS" | "ACCEPTED_NO_RESPONSE" | "NOT_LISTENING" | "AUTH_FAILED" | "MAKE_ERROR" | "TIMEOUT" | "NETWORK_ERROR" | "BAD_RESPONSE";

export interface DiagEnv extends StagingGateEnv {
  MAKE_DIAG_ENABLED?: string;
  MAKE_PAYMENT_WEBHOOK_URL?: string;
  MAKE_PAYMENT_API_KEY?: string;
  MAKE_VERIFY_WEBHOOK_URL?: string;
  MAKE_VERIFY_API_KEY?: string;
}

export const DIAG_MARKER = "DISCOVER";
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const COOLDOWN_MS = 3_000;

/** הכלי זמין רק אם הופעל במפורש, ורק כששער ה-Staging פעיל (תצורה תקינה + מארח Staging/מקומי מוכר, לא Production) */
export function isDiagnosticsAvailable(hostname: string, env: DiagEnv = process.env as DiagEnv): boolean {
  return env.MAKE_DIAG_ENABLED === "true" && isStagingGateActive(hostname, env);
}

function scenarioConfig(scenario: DiagScenario, env: DiagEnv): { url?: string; key?: string } {
  return scenario === "create"
    ? { url: env.MAKE_PAYMENT_WEBHOOK_URL, key: env.MAKE_PAYMENT_API_KEY }
    : { url: env.MAKE_VERIFY_WEBHOOK_URL, key: env.MAKE_VERIFY_API_KEY };
}

function isHttps(url: string | undefined): boolean {
  try {
    return !!url && new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** האם התרחיש מוגדר (בוליאן בלבד, בלי ערכים) */
export function scenarioConfigured(scenario: DiagScenario, env: DiagEnv): boolean {
  const { url, key } = scenarioConfig(scenario, env);
  return isHttps(url) && !!key;
}

/** גוף הבקשה לתרחיש יצירת הקישור: אותם שדות כמו ב-MakeGrowPaymentProvider.createPaymentRequest, עם נתוני דמה */
export function buildCreatePayload(): Record<string, string> {
  return {
    diagnostic: DIAG_MARKER,
    reference: deriveMakePaymentId("diag:create"),
    idempotencyKey: "diag:create",
    amount: "300.00",
    currency: "ILS",
    description: "בדיקת תקשורת - חבילת 5 שעות",
    purpose: "PACKAGE",
    fullName: "Test Customer",
    phone: "0500000000",
    email: "test@example.invalid",
  };
}

/** גוף הבקשה לתרחיש האימות. מבנה מוצע (טרם מאומת מול Make): מזהה פנימי + מזהי Grow דמה */
export function buildVerifyPayload(): Record<string, string> {
  return {
    diagnostic: DIAG_MARKER,
    reference: deriveMakePaymentId("diag:create"),
    processId: "DUMMY-PROCESS-ID",
    processToken: "DUMMY-PROCESS-TOKEN",
  };
}

export interface DiagResult {
  scenario: DiagScenario;
  outcome: DiagOutcome;
  httpStatus?: number;
  durationMs: number;
  /** שמות שדות ברמה העליונה בתשובה (ללא ערכים), לגילוי מבנה התשובה */
  responseFields?: string[];
  hasUrlField?: boolean;
  /** רמזים לאבחון, בוליאנים/מספרים בלבד: אין בהם ערכים סודיים */
  hints?: string[];
  /** אזהרות על תוצאה חשודה (לדוגמה: תשובת ack אמורה לא לכלול קישור תשלום) */
  warnings?: string[];
}

function authHints(scenario: DiagScenario, env: DiagEnv): string[] {
  const { url, key } = scenarioConfig(scenario, env);
  const hints = ["Make מחזיר 401 כשהכותרת x-make-apikey חסרה או שונה מהערך ב-Keychain של ה-Webhook בתרחיש"];
  if (key) {
    if (key !== key.trim()) hints.push("ערך המפתח ב-env כולל רווח או שורה חדשה בתחילתו/סופו");
    if (/^["'].*["']$/.test(key)) hints.push("ערך המפתח ב-env עטוף במרכאות");
    hints.push(`אורך המפתח ב-env: ${key.length} תווים`);
  }
  if (url) {
    try {
      const host = new URL(url).hostname;
      if (!/\.(make|integromat)\.com$/.test(host)) hints.push("כתובת ה-Webhook אינה בדומיין make.com");
    } catch {
      /* כבר נבדק ב-scenarioConfigured */
    }
  }
  if (env.MAKE_PAYMENT_API_KEY && env.MAKE_PAYMENT_API_KEY === env.MAKE_VERIFY_API_KEY) {
    hints.push("אותו מפתח מוגדר לשני התרחישים - ודאו שזה תואם ל-Keychain של כל אחד מהם");
  }
  hints.push("בדקו ב-Make שה-Keychain מוגדר עם Header name = x-make-apikey ושהוא מקושר ל-Webhook של התרחיש הנכון");
  return hints;
}

export async function runDiagnostic(scenario: DiagScenario, env: DiagEnv, fetchImpl: typeof fetch = fetch): Promise<DiagResult> {
  const { url, key } = scenarioConfig(scenario, env);
  if (!isHttps(url) || !key) throw new Error("scenario not configured");
  const payload = scenario === "create" ? buildCreatePayload() : buildVerifyPayload();
  const r = await postDiagnostic(url!, key, payload, fetchImpl);
  if (r.outcome === "AUTH_FAILED") return { scenario, ...r, hints: authHints(scenario, env) };
  // בגילוי שדות הבקשה מסומנת DISCOVER: קישור תשלום בתשובה משמעותו שייתכן שמודול Grow כן הורץ (הפילטר לא עצר אותו)
  const warnings = scenario === "create" && r.hasUrlField ? [GROW_RAN_WARNING] : undefined;
  return { scenario, ...r, warnings };
}

const GROW_RAN_WARNING = "התשובה כוללת url: ייתכן שמודול Grow הורץ. ודאו בהיסטוריית התרחיש ב-Make שהפילטר עוצר לפני Grow בבקשות DISCOVER";

/** שליחה אחת ל-Webhook של Make וסיווג התשובה. משותף לכלי האבחון ולבדיקת התקשורת של רכישת חבילה */
async function postDiagnostic(
  url: string,
  key: string,
  payload: Record<string, string | number>,
  fetchImpl: typeof fetch
): Promise<Omit<DiagResult, "scenario" | "warnings">> {
  const started = Date.now();
  const done = (r: Omit<DiagResult, "scenario" | "durationMs" | "warnings">) => ({ durationMs: Date.now() - started, ...r });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", [MAKE_API_KEY_HEADER]: key },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return done({ outcome: timedOut ? "TIMEOUT" : "NETWORK_ERROR" });
  }
  if (res.status === 401 || res.status === 403) return done({ outcome: "AUTH_FAILED", httpStatus: res.status });
  if (res.status === 410) {
    return done({ outcome: "NOT_LISTENING", httpStatus: 410, hints: ["אין תרחיש שמאזין לכתובת: הפעילו Run once (או הפעילו את התרחיש) ושלחו שוב תוך זמן ההמתנה"] });
  }
  if (!res.ok) return done({ outcome: "MAKE_ERROR", httpStatus: res.status });

  let json: unknown;
  try {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return done({ outcome: "BAD_RESPONSE", httpStatus: res.status });
    // גוף ריק או טקסט שאינו JSON (למשל "Accepted") = Make קלט את הבקשה בלי Webhook response: לא כשל אימות ולא כשל תקשורת
    if (text.trim() === "") return done({ outcome: "ACCEPTED_NO_RESPONSE", httpStatus: res.status });
    json = JSON.parse(text);
  } catch (err) {
    return done({ outcome: err instanceof SyntaxError ? "ACCEPTED_NO_RESPONSE" : "BAD_RESPONSE", httpStatus: res.status });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return done({ outcome: "BAD_RESPONSE", httpStatus: res.status });
  const obj = json as Record<string, unknown>;
  const responseFields = Object.keys(obj).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 20);
  const hasUrlField = typeof obj.url === "string" && obj.url.length > 0;
  return done({ outcome: "SUCCESS", httpStatus: res.status, responseFields, hasUrlField });
}

// ---- טיפול בבקשה (ללא תלות ב-Next, כדי שיהיה נבדק ישירות) ----

export interface DiagRequest {
  hostname: string;
  contentType: string | null;
  rawBody: string;
  env: DiagEnv;
  /** "ok" רק למנהל מחובר */
  authorize: () => Promise<"ok" | "unauthenticated" | "forbidden">;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DiagResponse {
  status: number;
  body: Record<string, unknown>;
}

const lastRun = new Map<DiagScenario, number>();
export function resetDiagnosticsCooldown(): void {
  lastRun.clear();
}

/** סדר בדיקה: זמינות (404 כשלא) -> הרשאה -> צורת הבקשה (תרחיש בלבד + אישור) -> קצב -> הרצה */
export async function handleDiagnosticsPost(req: DiagRequest): Promise<DiagResponse> {
  if (!isDiagnosticsAvailable(req.hostname, req.env)) return { status: 404, body: { error: "לא נמצא" } };
  const auth = await req.authorize();
  if (auth === "unauthenticated") return { status: 401, body: { error: "יש להתחבר" } };
  if (auth === "forbidden") return { status: 403, body: { error: "אין הרשאה" } };

  if (!req.contentType?.toLowerCase().startsWith("application/json")) return { status: 415, body: { error: "נדרש JSON" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "בקשה לא תקינה" } };
  }
  const bad = { status: 400, body: { error: "בקשה לא תקינה" } };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad;
  const body = parsed as Record<string, unknown>;
  // רשימה סגורה של שדות: כל שדה נוסף (url, headers, body, method...) נדחה, כך שאי אפשר להפוך את הנתיב ל-proxy
  if (Object.keys(body).some((k) => k !== "scenario" && k !== "confirmStopsBeforeGrow")) return bad;
  if (typeof body.scenario !== "string" || !DIAG_SCENARIOS.includes(body.scenario as DiagScenario)) return bad;
  const scenario = body.scenario as DiagScenario;
  if (body.confirmStopsBeforeGrow !== true) {
    return { status: 400, body: { error: "יש לאשר שהתרחיש ב-Make עוצר לפני Grow עבור בקשות אבחון" } };
  }
  if (!scenarioConfigured(scenario, req.env)) return { status: 409, body: { error: "התרחיש אינו מוגדר בסביבה" } };

  const now = (req.now ?? Date.now)();
  const last = lastRun.get(scenario);
  if (last !== undefined && now - last < COOLDOWN_MS) return { status: 429, body: { error: "נא להמתין מספר שניות בין בדיקות" } };
  lastRun.set(scenario, now);

  const result = await runDiagnostic(scenario, req.env, req.fetchImpl);
  return { status: 200, body: { result } };
}

export async function handleDiagnosticsGet(
  hostname: string,
  env: DiagEnv,
  authorize: DiagRequest["authorize"]
): Promise<DiagResponse> {
  if (!isDiagnosticsAvailable(hostname, env)) return { status: 404, body: { error: "לא נמצא" } };
  const auth = await authorize();
  if (auth === "unauthenticated") return { status: 401, body: { error: "יש להתחבר" } };
  if (auth === "forbidden") return { status: 403, body: { error: "אין הרשאה" } };
  return { status: 200, body: { scenarios: { create: { configured: scenarioConfigured("create", env) }, verify: { configured: scenarioConfigured("verify", env) } } } };
}

// ---- בדיקת תקשורת מרכישת חבילת 5 שעות (Staging בלבד) ----

/**
 * כשהדגל MAKE_PACKAGE_PING_ENABLED פעיל ב-Staging, לחיצה על רכישת חבילת 5 שעות במרכז השעות שולחת בקשה אחת ל-Webhook
 * הקיים של Make (MAKE_PAYMENT_WEBHOOK_URL) - ולא יותר: לא נוצר Payment, לא נקרא ספק תשלום, לא נוצר קישור Grow ולא
 * נוספות שעות. הבקשה מסומנת diagnostic=DISCOVER ו-test=COMMUNICATION_ONLY כדי שהפילטר בתרחיש יעצור לפני Grow.
 */
export const PACKAGE_PING_HOURS = 5;
/** קידומת שאינה תואמת אף מזהה תשלום אמיתי (make:<hex> של ספק Make, או מזהה Payment במסד) */
export const PACKAGE_PING_ID_PREFIX = "commtest_";
export const COMMUNICATION_ONLY = "COMMUNICATION_ONLY";
const PING_CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const PING_CACHE_MAX = 500;

export interface PackagePingEnv extends StagingGateEnv {
  MAKE_PACKAGE_PING_ENABLED?: string;
  MAKE_PAYMENT_WEBHOOK_URL?: string;
  MAKE_PAYMENT_API_KEY?: string;
}

/** זמין רק בהפעלה מפורשת, בשער Staging פעיל (מארח Staging מוכר, לעולם לא Production), ועם Webhook מוגדר ב-HTTPS */
export function isPackagePingAvailable(hostname: string, env: PackagePingEnv = process.env as PackagePingEnv): boolean {
  return env.MAKE_PACKAGE_PING_ENABLED === "true" && isStagingGateActive(hostname, env) && isHttps(env.MAKE_PAYMENT_WEBHOOK_URL) && !!env.MAKE_PAYMENT_API_KEY;
}

/**
 * מזהה רכישת בדיקה: דטרמיניסטי לפי משתמש + clientKey (לחיצה כפולה = אותו מזהה; כוונת רכישה חדשה = מזהה חדש).
 * מרחב שמות נפרד (commtest:) וקידומת נפרדת, כך שלא יתנגש ולא ישמש כמזהה עסקה אמיתי.
 */
export function derivePackagePingId(userId: string, clientKey: string): string {
  return PACKAGE_PING_ID_PREFIX + createHash("sha256").update(`commtest:package:${userId}:${clientKey}`).digest("hex").slice(0, 32);
}

/** גוף הבקשה: מזהים פנימיים ומחיר מהשרת בלבד. בלי שם, טלפון, אימייל, פרטי אשראי או סודות */
export function buildPackagePingPayload(p: { purchaseId: string; customerRef: string; amountAgorot: number }): Record<string, string | number> {
  return {
    diagnostic: DIAG_MARKER,
    test: COMMUNICATION_ONLY,
    purchaseId: p.purchaseId,
    purchaseType: "PACKAGE",
    hours: PACKAGE_PING_HOURS,
    customerRef: p.customerRef,
    amount: agorotToShekels(p.amountAgorot),
    currency: "ILS",
  };
}

export interface PackagePingRequest {
  hostname: string;
  rawBody: string;
  env: PackagePingEnv;
  /** המשתמש המחובר (null = לא מחובר) */
  userId: string | null;
  loadUser: (id: string) => Promise<{ role: string; status: string } | null>;
  /** מחיר החבילה מטבלת המחירים בשרת (null = אין חבילה כזו) */
  loadPackagePriceAgorot: (hours: number) => Promise<number | null>;
  fetchImpl?: typeof fetch;
}

const DELIVERED: DiagOutcome[] = ["SUCCESS", "ACCEPTED_NO_RESPONSE"];
const pingsInFlight = new Map<string, Promise<DiagResponse>>();
export function resetPackagePings(): void {
  pingsInFlight.clear();
}

/**
 * מחזיר null כשהבדיקה אינה חלה (כבויה / לא Staging / חבילה שאינה 5 שעות) - ואז הנתיב ממשיך בדיוק כמו קודם.
 * אותו purchaseId לא נשלח פעמיים (גם בבקשות מקבילות); אחרי כשל משלוח מותר לנסות שוב עם אותו מזהה.
 */
export async function handlePackagePing(req: PackagePingRequest): Promise<DiagResponse | null> {
  if (!isPackagePingAvailable(req.hostname, req.env)) return null;
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(req.rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (Number(body?.hours) !== PACKAGE_PING_HOURS) return null;

  if (!req.userId) return { status: 401, body: { error: "יש להתחבר" } };
  const userId = req.userId;
  const clientKey = typeof body?.clientKey === "string" ? body.clientKey : "";
  if (!PING_CLIENT_KEY.test(clientKey)) return { status: 400, body: { error: "מפתח הבקשה אינו תקין" } };
  const user = await req.loadUser(userId);
  if (!user || user.role !== "CLIENT" || user.status !== "APPROVED") return { status: 403, body: { error: "רק לקוח מאושר רשאי לרכוש חבילה" } };
  // המחיר נקבע בשרת בלבד; כל שדה מחיר שהגיע מהדפדפן מתעלמים ממנו
  const amountAgorot = await req.loadPackagePriceAgorot(PACKAGE_PING_HOURS);
  if (!amountAgorot || !Number.isInteger(amountAgorot) || amountAgorot <= 0) return { status: 400, body: { error: "חבילה לא קיימת" } };

  const purchaseId = derivePackagePingId(userId, clientKey);
  const existing = pingsInFlight.get(purchaseId);
  if (existing) return existing;

  const run = (async (): Promise<DiagResponse> => {
    const payload = buildPackagePingPayload({ purchaseId, customerRef: userId, amountAgorot });
    const r = await postDiagnostic(req.env.MAKE_PAYMENT_WEBHOOK_URL!, req.env.MAKE_PAYMENT_API_KEY!, payload, req.fetchImpl ?? fetch);
    if (!DELIVERED.includes(r.outcome)) pingsInFlight.delete(purchaseId);
    // לעולם לא מחזירים ללקוח תוכן מתשובת Make (בפרט לא קישור תשלום) - רק סיווג
    return {
      status: 202,
      body: {
        communicationTest: true,
        purchaseId,
        hours: PACKAGE_PING_HOURS,
        amountAgorot,
        outcome: r.outcome,
        httpStatus: r.httpStatus,
        warnings: r.hasUrlField ? [GROW_RAN_WARNING] : undefined,
      },
    };
  })();
  if (pingsInFlight.size >= PING_CACHE_MAX) pingsInFlight.clear();
  pingsInFlight.set(purchaseId, run);
  return run;
}
