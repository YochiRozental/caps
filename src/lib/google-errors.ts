/** הודעות שגיאה של התחברות Google. מודול משותף ללקוח ולשרת: בלי React ובלי APIs של דפדפן */
export const GOOGLE_ERRORS: Record<string, string> = {
  google_email_unverified: "כתובת האימייל בחשבון Google אינה מאומתת, ולכן לא ניתן להמשיך.",
  google_email_exists:
    "כבר קיים חשבון עם האימייל הזה. התחברו עם אימייל וסיסמה, ובאזור האישי בחרו ״קישור חשבון Google״.",
  google_already_linked: "חשבון Google זה כבר מקושר למשתמש אחר.",
  google_link_denied: "לא ניתן להתחבר או לקשר Google לחשבון זה.",
  google_failed: "ההתחברות עם Google נכשלה. נסו שוב.",
  OAuthCallbackError: "ההתחברות עם Google בוטלה.",
  AccessDenied: "ההתחברות עם Google בוטלה.",
};

export function googleErrorMessage(code: string | null) {
  if (!code) return null;
  return GOOGLE_ERRORS[code] ?? (code === "CredentialsSignin" ? null : "ההתחברות עם Google נכשלה. נסו שוב.");
}
