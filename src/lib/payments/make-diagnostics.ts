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
  const started = Date.now();
  const done = (r: Omit<DiagResult, "scenario" | "durationMs">): DiagResult => ({ scenario, durationMs: Date.now() - started, ...r });
  if (!isHttps(url) || !key) throw new Error("scenario not configured");

  let res: Response;
  try {
    res = await fetchImpl(url!, {
      method: "POST",
      headers: { "content-type": "application/json", [MAKE_API_KEY_HEADER]: key },
      body: JSON.stringify(scenario === "create" ? buildCreatePayload() : buildVerifyPayload()),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return done({ outcome: timedOut ? "TIMEOUT" : "NETWORK_ERROR" });
  }
  if (res.status === 401 || res.status === 403) return done({ outcome: "AUTH_FAILED", httpStatus: res.status, hints: authHints(scenario, env) });
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
  // בגילוי שדות הבקשה מסומנת DISCOVER: קישור תשלום בתשובה משמעותו שייתכן שמודול Grow כן הורץ (הפילטר לא עצר אותו)
  const warnings = scenario === "create" && hasUrlField ? ["התשובה כוללת url: ייתכן שמודול Grow הורץ. ודאו בהיסטוריית התרחיש ב-Make שהפילטר עוצר לפני Grow בבקשות DISCOVER"] : undefined;
  return done({ outcome: "SUCCESS", httpStatus: res.status, responseFields, hasUrlField, warnings });
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
