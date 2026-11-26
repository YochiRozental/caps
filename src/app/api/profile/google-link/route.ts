import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { GOOGLE_LINK_COOKIE, GOOGLE_PROVIDER, LINK_INTENT_MAX_AGE_SECONDS, createLinkIntent } from "@/lib/google-auth";

const schema = z.object({ password: z.string().min(1, "יש להזין את הסיסמה") });

/**
 * שלב 1 בקישור חשבון Google לחשבון קיים: הוכחת בעלות (session מחובר + סיסמת האתר) ואז cookie חתום וקצר-חיים
 * שמאפשר ל-callback של Google לקשר את החשבון שייבחר למשתמש הזה בלבד. אין קישור לחשבון מנהל.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true, passwordHash: true, mustChangePassword: true, oauthAccounts: { where: { provider: GOOGLE_PROVIDER }, select: { id: true } } },
  });
  if (!user || user.role !== "CLIENT" || user.mustChangePassword) {
    return NextResponse.json({ error: "לא ניתן לקשר חשבון Google לחשבון זה" }, { status: 403 });
  }
  if (user.oauthAccounts.length > 0) return NextResponse.json({ error: "חשבון Google כבר מקושר" }, { status: 409 });
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: "הסיסמה שגויה" }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(GOOGLE_LINK_COOKIE, createLinkIntent(user.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: LINK_INTENT_MAX_AGE_SECONDS,
  });
  return response;
}
