import { NextResponse } from "next/server";
import { safeInternalPath } from "@/lib/safe-path";
import { GATE_COOKIE_MAX_AGE_SECONDS, GATE_COOKIE_NAME, isStagingGateActive, LOGIN_PAGE_PATH } from "@/lib/staging-gate/config";
import { gateCookieValue, passwordMatches } from "@/lib/staging-gate/token";

/**
 * קבלת הסיסמה והנפקת עוגיית הגישה לשער ה-Staging. כש-השער לא פעיל עבור המארח הנוכחי (כבוי, לא מוגדר כראוי,
 * או שזהו Production) הנתיב מחזיר 404 כאילו אינו קיים כלל — בדיוק כמו תבנית CRON_SECRET.
 */
export async function POST(request: Request) {
  const hostname = new URL(request.url).hostname;
  if (!isStagingGateActive(hostname)) {
    return NextResponse.json({ error: "לא נמצא" }, { status: 404 });
  }

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const next = safeInternalPath(String(form.get("next") ?? ""), "/");

  const ok = await passwordMatches(password, process.env.STAGING_GATE_PASSWORD);
  if (!ok) {
    const failUrl = new URL(LOGIN_PAGE_PATH, request.url);
    failUrl.searchParams.set("error", "1");
    failUrl.searchParams.set("next", next);
    return NextResponse.redirect(failUrl, { status: 303 });
  }

  const response = NextResponse.redirect(new URL(next, request.url), { status: 303 });
  response.cookies.set({
    name: GATE_COOKIE_NAME,
    value: await gateCookieValue(process.env.STAGING_GATE_PASSWORD!),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: GATE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
