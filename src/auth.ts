import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { cookies } from "next/headers";
import { authConfig } from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { GOOGLE_LINK_COOKIE, GOOGLE_PROVIDER, readLinkIntent, resolveGoogleLogin } from "@/lib/google-auth";

/** Google מופעל רק כשהמפתחות מוגדרים בסביבה (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET) — בלעדיהם הכפתור לא מופיע */
const googleEnabled = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  pages: { ...authConfig.pages, error: "/login" },
  callbacks: {
    ...authConfig.callbacks,
    signIn: async ({ account, profile }) => {
      if (account?.provider !== GOOGLE_PROVIDER) return true;

      const cookieStore = await cookies();
      const linkUserId = readLinkIntent(cookieStore.get(GOOGLE_LINK_COOKIE)?.value);
      if (linkUserId) {
        try {
          cookieStore.delete(GOOGLE_LINK_COOKIE);
        } catch {
          // ה-cookie קצר-חיים וחתום; אי-מחיקה אינה מסוכנת
        }
      }

      try {
        const result = await resolveGoogleLogin(
          {
            sub: account.providerAccountId,
            email: profile?.email,
            emailVerified: profile?.email_verified === true,
            givenName: profile?.given_name as string | undefined,
            familyName: profile?.family_name as string | undefined,
            name: profile?.name,
          },
          linkUserId
        );
        if (result.ok) return true;
        return `${linkUserId ? "/profile" : "/login"}?error=${result.error}`;
      } catch (error) {
        // לא נרשמים tokens/פרופיל — רק סוג השגיאה
        console.error("[google-auth] sign-in failed:", error instanceof Error ? error.name : "unknown");
        return `${linkUserId ? "/profile" : "/login"}?error=google_failed`;
      }
    },
    jwt: async (params) => {
      const { token, account } = params;
      if (account?.provider === GOOGLE_PROVIDER) {
        // נתוני ה-session נלקחים תמיד ממשתמש המסד המקושר ל-sub, לעולם לא מפרופיל Google
        const linked = await prisma.oAuthAccount.findUnique({
          where: { provider_providerAccountId: { provider: GOOGLE_PROVIDER, providerAccountId: account.providerAccountId } },
          select: { user: { select: { id: true, role: true, status: true, mustChangePassword: true } } },
        });
        if (!linked) throw new Error("google account not linked");
        token.id = linked.user.id;
        token.role = linked.user.role;
        token.status = linked.user.status;
        token.mustChangePassword = linked.user.mustChangePassword;
        return token;
      }
      return authConfig.callbacks!.jwt!(params);
    },
  },
  providers: [
    ...(googleEnabled
      ? [
          Google({
            // רק openid/email/profile; בלי prompt קבוע (Google בוחר לפי ה-session בדפדפן; קישור חשבון מבקש select_account בנפרד). אין קישור אוטומטי לפי אימייל (allowDangerousEmailAccountLinking כבוי)
            authorization: { params: { scope: "openid email profile" } },
          }),
        ]
      : []),
    Credentials({
      credentials: {
        email: { label: "אימייל", type: "email" },
        password: { label: "סיסמה", type: "password" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase().trim() },
        });
        if (!user) return null;

        const isValid = await verifyPassword(password, user.passwordHash);
        if (!isValid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
});
