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
