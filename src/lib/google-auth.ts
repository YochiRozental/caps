import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * התחברות/הרשמה עם Google. כללי ברזל:
 *  - הזיהוי הוא לפי Google `sub` בלבד (טבלת OAuthAccount). אימייל לעולם אינו מקשר חשבון קיים אוטומטית.
 *  - קישור לחשבון קיים אפשרי רק מתוך session מחובר + הוכחת סיסמה (ראו GOOGLE_LINK_COOKIE), ולא לחשבון מנהל.
 *  - משתמש חדש נוצר כ-CLIENT/PENDING, בלי טלפון/ת"ז/סיסמה — את החובה משלימים במסך complete-profile הקיים.
 */
export const GOOGLE_PROVIDER = "google";
export const GOOGLE_LINK_COOKIE = "caps-google-link";
const LINK_TTL_MS = 10 * 60 * 1000;

export type GoogleLoginError =
  | "google_email_unverified"
  | "google_email_exists"
  | "google_already_linked"
  | "google_link_denied"
  | "google_failed";

export type GoogleLoginResult = { ok: true; userId: string } | { ok: false; error: GoogleLoginError };

export type GoogleIdentity = {
  sub: string | undefined;
  email: string | undefined | null;
  emailVerified: boolean | undefined;
  givenName?: string | null;
  familyName?: string | null;
  name?: string | null;
};

// ── אסימון כוונת קישור: נחתם ב-AUTH_SECRET, קצר-חיים, נשלח ב-cookie HttpOnly רק לדפדפן של משתמש שהוכיח סיסמה ──
function sign(payload: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing");
  return createHmac("sha256", secret).update(`google-link:${payload}`).digest("base64url");
}

export function createLinkIntent(userId: string, now = Date.now()) {
  const payload = `${userId}.${now + LINK_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** מחזיר את userId אם האסימון חתום ובתוקף, אחרת null */
export function readLinkIntent(token: string | undefined | null, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts;
  const expected = sign(`${userId}.${expires}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!Number.isFinite(Number(expires)) || Number(expires) < now) return null;
  return userId;
}

export const LINK_INTENT_MAX_AGE_SECONDS = LINK_TTL_MS / 1000;

function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

type Db = typeof prisma;

/** סוגר את ההחלטה למשתמש המקושר: רק לקוח רגיל (לעולם לא מנהל/צוות). חסום/ממתין נכנסים כרגיל ונעצרים במסכי הסטטוס הקיימים */
async function loginLinked(db: Db, sub: string): Promise<GoogleLoginResult | null> {
  const linked = await db.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: GOOGLE_PROVIDER, providerAccountId: sub } },
    select: { user: { select: { id: true, role: true } } },
  });
  if (!linked) return null;
  if (linked.user.role !== "CLIENT") return { ok: false, error: "google_link_denied" };
  return { ok: true, userId: linked.user.id };
}

export async function resolveGoogleLogin(
  identity: GoogleIdentity,
  linkUserId: string | null,
  db: Db = prisma
): Promise<GoogleLoginResult> {
  const sub = identity.sub;
  const email = identity.email?.toLowerCase().trim();
  if (!sub) return { ok: false, error: "google_failed" };

  const existingLink = await loginLinked(db, sub);

  // ── קישור חשבון קיים (המשתמש הוכיח בעלות: session + סיסמה) ──
  if (linkUserId) {
    if (existingLink) {
      if (existingLink.ok && existingLink.userId === linkUserId) return existingLink;
      return existingLink.ok ? { ok: false, error: "google_already_linked" } : existingLink;
    }
    const target = await db.user.findUnique({
      where: { id: linkUserId },
      select: { id: true, role: true, mustChangePassword: true },
    });
    if (!target || target.role !== "CLIENT" || target.mustChangePassword) return { ok: false, error: "google_link_denied" };
    try {
      await db.oAuthAccount.create({
        data: { provider: GOOGLE_PROVIDER, providerAccountId: sub, email: email ?? null, userId: target.id },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: "google_already_linked" };
      throw e;
    }
    return { ok: true, userId: target.id };
  }

  if (existingLink) return existingLink;

  // ── משתמש חדש ──
  if (!email || identity.emailVerified !== true) return { ok: false, error: "google_email_unverified" };

  // אימייל קיים אצלנו ללא קישור: אין קישור אוטומטי. חייבים להתחבר בסיסמה ולקשר מהאזור האישי
  const sameEmail = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (sameEmail) return { ok: false, error: "google_email_exists" };

  const firstName = identity.givenName?.trim() || null;
  const lastName = identity.familyName?.trim() || null;
  const name = [firstName, lastName].filter(Boolean).join(" ") || identity.name?.trim() || email;
  try {
    const user = await db.user.create({
      data: {
        name,
        firstName,
        lastName,
        email,
        passwordHash: null,
        oauthAccounts: { create: { provider: GOOGLE_PROVIDER, providerAccountId: sub, email } },
      },
      select: { id: true },
    });
    return { ok: true, userId: user.id };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // בקשה מקבילה: אם היא יצרה את אותו sub — מתחברים אליו; אחרת זו התנגשות אימייל
    const raced = await loginLinked(db, sub);
    return raced ?? { ok: false, error: "google_email_exists" };
  }
}
