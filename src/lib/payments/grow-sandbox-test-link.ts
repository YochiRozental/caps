import { isDiagnosticsAvailable, type DiagEnv } from "@/lib/payments/make-diagnostics";

/**
 * קישור בדיקה קבוע ל-Grow Sandbox (כפתור "תשלום ניסיון ב-Grow" בדף האבחון, Staging בלבד, מנהל בלבד).
 * הקישור נקבע במשתנה סביבה ייעודי וכל מה שהקוד עושה הוא לאמת אותו ולהציג קישור: אין כאן יצירת הזמנה, חבילה,
 * חיוב או רשומת תשלום, ואין שימוש בספקי התשלום. הדומיין המותר הוא דומיין ה-Sandbox של Grow שכבר מוגדר בקוד
 * (GROW_SANDBOX_BASE_URL ב-grow-provider.ts): sandbox.meshulam.co.il ותתי-דומיינים שלו בלבד.
 */
export const GROW_SANDBOX_CHECKOUT_HOST = "sandbox.meshulam.co.il";

export interface GrowTestLinkEnv extends DiagEnv {
  GROW_SANDBOX_TEST_CHECKOUT_URL?: string;
}

export type GrowTestLink =
  | { status: "unavailable" }
  | { status: "not_configured" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; url: string };

export function validateGrowSandboxCheckoutUrl(value: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return { ok: false, reason: "הקישור ריק או ארוך מדי" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "הקישור אינו כתובת תקינה" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "הקישור חייב להיות HTTPS" };
  if (url.username || url.password) return { ok: false, reason: "הקישור כולל פרטי גישה מוטמעים" };
  if (url.port) return { ok: false, reason: "הקישור כולל פורט לא סטנדרטי" };
  const host = url.hostname.toLowerCase();
  if (host !== GROW_SANDBOX_CHECKOUT_HOST && !host.endsWith(`.${GROW_SANDBOX_CHECKOUT_HOST}`)) {
    return { ok: false, reason: `הדומיין אינו ${GROW_SANDBOX_CHECKOUT_HOST}` };
  }
  return { ok: true, url: url.toString() };
}

export function resolveGrowTestLink(hostname: string, env: GrowTestLinkEnv = process.env as GrowTestLinkEnv): GrowTestLink {
  if (!isDiagnosticsAvailable(hostname, env)) return { status: "unavailable" };
  const raw = env.GROW_SANDBOX_TEST_CHECKOUT_URL;
  if (!raw || raw.trim() === "") return { status: "not_configured" };
  const v = validateGrowSandboxCheckoutUrl(raw);
  return v.ok ? { status: "ok", url: v.url } : { status: "invalid", reason: v.reason };
}
