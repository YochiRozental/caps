import NextAuth, { type NextAuthRequest } from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "@/auth.config";
import { GATE_COOKIE_NAME, LOGIN_PAGE_PATH, SERVICE_KEY_HEADER } from "@/lib/staging-gate/config";
import { decideStagingGate } from "@/lib/staging-gate/evaluate";
import { safeInternalPath } from "@/lib/safe-path";

const { auth } = NextAuth(authConfig);

/** נתיבים שה-middleware המקורי (NextAuth) נועד לרוץ עליהם — ללא שינוי בהתנהגות הקיימת */
const AUTH_HANDLED_PATHS = [/^\/$/, /^\/booking(\/|$)/, /^\/admin(\/|$)/, /^\/login$/, /^\/register$/, /^\/account-status$/, /^\/complete-profile$/, /^\/change-password$/, /^\/profile$/];
const isAuthHandledPath = (pathname: string) => AUTH_HANDLED_PATHS.some((re) => re.test(pathname));

// חתימה מפורשת עם שני פרמטרים (ולא פרמטר יחיד), כדי לאלץ TypeScript לבחור את ה-overload של middleware
// (NextAuthMiddleware) ולא את זה של Route Handler - כדי שאפשר יהיה לקרוא לפונקציה הזו עם NextFetchEvent למטה
const authMiddleware = auth((req: NextAuthRequest, _event: NextFetchEvent) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isAdmin = req.auth?.user?.role === "ADMIN";

  // סיסמה זמנית (שהוגדרה ע"י מנהל) — חובה להחליף לפני כל שימוש אחר
  if (isLoggedIn && req.auth?.user?.mustChangePassword) {
    if (pathname === "/change-password") return NextResponse.next();
    return NextResponse.redirect(new URL("/change-password", req.url));
  }
  if (pathname === "/change-password") {
    return NextResponse.redirect(new URL(isLoggedIn ? "/" : "/login", req.url));
  }

  // מנהל רואה רק את אזור הניהול
  if (isAdmin && !pathname.startsWith("/admin")) {
    return NextResponse.redirect(new URL("/admin", req.url));
  }

  if (pathname.startsWith("/admin") && (!isLoggedIn || !isAdmin)) {
    const url = new URL(isLoggedIn ? "/booking" : "/login", req.url);
    if (!isLoggedIn) url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  // עמוד הזמנת החדר (/booking) פתוח לכולם; ההתחברות והפרטים נבדקים רק בעת ההזמנה בפועל
  if (pathname.startsWith("/booking") && pathname !== "/booking" && pathname !== "/booking/") {
    if (!isLoggedIn) {
      const url = new URL("/login", req.url);
      url.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(url);
    }
    // סטטוס האישור ב-session עלול להיות ישן (נשמר ב-JWT), לכן הוא נאכף בשרת מול מסד הנתונים בעת ההזמנה
  }

  // השלמת פרטים דורשת התחברות (גם למשתמש שטרם אושר)
  if (pathname.startsWith("/complete-profile") && !isLoggedIn) {
    const url = new URL("/login", req.url);
    url.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/profile") && !isLoggedIn) {
    const url = new URL("/login", req.url);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

/**
 * שער Staging: רץ לפני לוגיקת ההתחברות הרגילה של האתר, על כל נתיב (עמודים ו-API כאחד). כבוי כברירת מחדל -
 * ראו src/lib/staging-gate/config.ts לתנאים המדויקים להפעלתו. כשהוא לא פעיל (המצב הנוכחי, גם ב-Staging כרגע
 * וגם תמיד ב-Production) ההתנהגות זהה לחלוטין לקודם.
 */
export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;
  const decision = await decideStagingGate({
    hostname: req.nextUrl.hostname,
    pathname,
    cookieValue: req.cookies.get(GATE_COOKIE_NAME)?.value,
    serviceKeyHeader: req.headers.get(SERVICE_KEY_HEADER),
  });

  if (decision === "denied") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "אין הרשאה" }, { status: 401 });
    }
    const loginUrl = new URL(LOGIN_PAGE_PATH, req.url);
    loginUrl.searchParams.set("next", safeInternalPath(pathname + req.nextUrl.search, "/"));
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthHandledPath(pathname)) {
    return authMiddleware(req, event);
  }
  return NextResponse.next();
}

export const config = {
  // כל נתיב חוץ מנכסי Next הפנימיים (קבצי האתר של NextAuth, booking וכו' מסוננים בפנים, לפי isAuthHandledPath)
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
