/**
 * האם דף התשלום של הספק מתיר הטמעה (iframe) באתר שלנו, לפי כותרות האבטחה שהוא עצמו שולח. לא עוקפים דבר:
 * אם הספק אוסר הטמעה (X-Frame-Options / CSP frame-ancestors) - החלונית פותחת את הדף בחלון נפרד במקום iframe שבור.
 * Grow, למשל, שולח ב-sandbox.grow.link את frame-ancestors https://grow.website https://*.grow.website, עד שהדומיין
 * שלנו מאושר להטמעה אצלם.
 */

/** בודק מקור אחד מרשימת frame-ancestors מול ה-origin שלנו */
function sourceAllows(source: string, origin: URL, checkout: URL): boolean {
  const s = source.trim().toLowerCase();
  if (!s) return false;
  if (s === "*") return true;
  if (s === "'none'") return false;
  if (s === "'self'") return origin.origin === checkout.origin;
  if (s === "https:") return origin.protocol === "https:";
  const m = /^(?:(https?):\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?\/?$/.exec(s);
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  if (scheme && `${scheme}:` !== origin.protocol) return false;
  if (!scheme && origin.protocol !== "https:") return false;
  if (port && port !== "*" && port !== (origin.port || (origin.protocol === "https:" ? "443" : "80"))) return false;
  const ours = origin.hostname.toLowerCase();
  return wildcard ? ours.endsWith(`.${host}`) : ours === host;
}

/**
 * מחליט לפי הכותרות. CSP frame-ancestors גובר על X-Frame-Options (כך בדפדפנים מודרניים). מחזיר true כשאין הגבלה.
 */
export function framingAllowed(headers: { get(name: string): string | null }, ourOrigin: string, checkoutUrl: string): boolean {
  const origin = new URL(ourOrigin);
  const checkout = new URL(checkoutUrl);
  const csp = headers.get("content-security-policy");
  if (csp) {
    // כמה מדיניויות בכותרת אחת (מופרדות בפסיק) - כל אחת חייבת להתיר
    const policies = csp.split(",");
    let sawFrameAncestors = false;
    for (const policy of policies) {
      const directive = policy
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
      if (!directive) continue;
      sawFrameAncestors = true;
      const sources = directive.split(/\s+/).slice(1);
      if (!sources.some((src) => sourceAllows(src, origin, checkout))) return false;
    }
    if (sawFrameAncestors) return true;
  }
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo === "deny") return false;
  if (xfo === "sameorigin") return origin.origin === checkout.origin;
  return true;
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * בדיקת שרת של דף התשלום (GET בלי הרצת סקריפטים - רק קריאת כותרות). החלטה שמרנית: true רק כשהדף עצמו נטען (2xx)
 * וכותרותיו מתירות הטמעה. כל דבר אחר (כשל רשת, חריגת זמן, דף חסימת-בוטים או שגיאה שמחזירים לשרת בלי כותרות הדף
 * האמיתי) = false, והחלונית פותחת חלון נפרד שתמיד עובד. כך לא מוצג iframe שהדפדפן יחסום.
 * הבדיקה היא חוויית משתמש בלבד ואינה נוגעת בתשלום.
 */
export async function probeCheckoutEmbeddable(
  checkoutUrl: string,
  ourOrigin: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ embeddable: boolean; reason: string }> {
  try {
    const res = await fetchImpl(checkoutUrl, {
      method: "GET",
      redirect: "follow",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // לא קוראים את הגוף: רק הכותרות רלוונטיות
    res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 300) return { embeddable: false, reason: `http_${res.status}` };
    const allowed = framingAllowed(res.headers, ourOrigin, res.url || checkoutUrl);
    return { embeddable: allowed, reason: allowed ? "headers_allow" : "headers_forbid" };
  } catch {
    return { embeddable: false, reason: "probe_failed" };
  }
}

// ───────────────────────────── מדיניות הטמעה לפי דומיין (בלי בדיקת רשת כשהתשובה ידועה) ─────────────────────────────

/**
 * דומיינים שידוע שאוסרים הטמעה באתר שלנו. נמדד בנובמבר 2026: sandbox.grow.link ו-pay.grow.link (דפי Payment Link)
 * שולחים frame-ancestors https://grow.website https://*.grow.website ו-X-Frame-Options: SAMEORIGIN. בדיקת הכותרות
 * בכל רכישה רק האריכה את ההמתנה (עד 3 שניות) בלי לשנות את התוצאה. אם Grow יאשר את הדומיין שלנו, מגדירים את המארח
 * ב-CHECKOUT_EMBEDDABLE_HOSTS, וההגדרה המפורשת גוברת על הרשימה הזו.
 */
export const KNOWN_NON_EMBEDDABLE_HOSTS: readonly string[] = ["grow.link"];

export interface FramingHostConfig {
  /** מארחים שאושרו להטמעה (אחרי בדיקה ידנית/אישור Grow): לא נבדקים ברשת, תמיד iframe */
  embeddable: readonly string[];
  /** מארחים שאוסרים הטמעה (נוסף על KNOWN_NON_EMBEDDABLE_HOSTS): לא נבדקים ברשת, תמיד חלון נפרד */
  nonEmbeddable: readonly string[];
}

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function parseHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOST_NAME.test(h));
}

/** תצורה מ-env: CHECKOUT_EMBEDDABLE_HOSTS / CHECKOUT_NON_EMBEDDABLE_HOSTS (שמות מארח מופרדים בפסיקים; ערך לא תקין נזרק) */
export function framingHostConfigFromEnv(env: Record<string, string | undefined>): FramingHostConfig {
  return {
    embeddable: parseHosts(env.CHECKOUT_EMBEDDABLE_HOSTS),
    nonEmbeddable: [...KNOWN_NON_EMBEDDABLE_HOSTS, ...parseHosts(env.CHECKOUT_NON_EMBEDDABLE_HOSTS)],
  };
}

export type FramingPolicy = "embeddable" | "not-embeddable" | "unknown";

/** החלטה לפי דומיין בלבד, בלי רשת. הגדרה מפורשת של "מותר" גוברת על "אסור" */
export function framingPolicyForHost(host: string, cfg: FramingHostConfig): FramingPolicy {
  const h = host.toLowerCase();
  if (hostMatches(h, cfg.embeddable)) return "embeddable";
  if (hostMatches(h, cfg.nonEmbeddable)) return "not-embeddable";
  return "unknown";
}

/** תוצאות בדיקה ודאיות (הכותרות עצמן התירו/אסרו) נשמרות לפי מארח, כדי לא לבדוק שוב בכל רכישה */
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_MAX = 32;
const probeCache = new Map<string, { embeddable: boolean; at: number }>();

export function clearFramingProbeCache(): void {
  probeCache.clear();
}

export interface CheckoutEmbeddability {
  /** true: iframe. false: חלון נפרד. undefined: לא ידוע - מנסים iframe, עם אפשרות חלופית גלויה בחלונית */
  embeddable: boolean | undefined;
  /** סיבה קצרה ללוג (ערכים קבועים, בלי כתובות) */
  reason: string;
  /** האם בוצעה בקשת רשת בפועל */
  probed: boolean;
}

/**
 * האם להציג את דף התשלום ב-iframe. סדר ההחלטה: מדיניות לפי דומיין (בלי רשת) -> תוצאה שמורה -> בדיקת כותרות.
 * כשל בדיקה (חסימת בוטים, שגיאת שרת, זמן) אינו ודאי ולכן מחזיר undefined: החלונית מנסה iframe ומציגה אפשרות
 * חלופית ברורה. זו החלטת חוויית משתמש בלבד, ואינה נוגעת בתשלום או באימות שלו.
 */
export async function resolveCheckoutEmbeddable(
  checkoutUrl: string,
  ourOrigin: string,
  cfg: FramingHostConfig,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<CheckoutEmbeddability> {
  const host = new URL(checkoutUrl).hostname.toLowerCase();
  const policy = framingPolicyForHost(host, cfg);
  if (policy === "embeddable") return { embeddable: true, reason: "host_allowed", probed: false };
  if (policy === "not-embeddable") return { embeddable: false, reason: "host_known_forbid", probed: false };

  const now = opts.now ?? Date.now;
  const cached = probeCache.get(host);
  if (cached && now() - cached.at < PROBE_CACHE_TTL_MS) {
    return { embeddable: cached.embeddable, reason: cached.embeddable ? "cached_allow" : "cached_forbid", probed: false };
  }
  const probe = await probeCheckoutEmbeddable(checkoutUrl, ourOrigin, opts.fetchImpl);
  if (probe.reason === "headers_allow" || probe.reason === "headers_forbid") {
    if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
    probeCache.set(host, { embeddable: probe.embeddable, at: now() });
    return { embeddable: probe.embeddable, reason: probe.reason, probed: true };
  }
  return { embeddable: undefined, reason: probe.reason, probed: true };
}
