export const SITE_URL = "https://caps.co.il";
export const SITE_NAME = "הקפסולה";
export const SITE_TITLE = "הקפסולה – קליניקות להשכרה לפי שעה במודיעין עילית";
export const SITE_DESCRIPTION =
  "הקפסולה מציעה קליניקות מעוצבות ומאובזרות להשכרה לפי שעה במודיעין עילית, חדר סדנאות, חדר המתנה ומטבחון מאובזר. הזמינו קליניקה בקלות ובאופן מקוון.";

/** סביבות Staging ידועות (לפי שם המארח ש-Render מזריק לשירות, לא לפי כותרת הבקשה) */
const NON_PRODUCTION_HOSTS = new Set(["caps-staging-ppb1.onrender.com"]);

/** אינדוקס מותר רק ב-Production: לא ב-Staging (Render), לא בפיתוח מקומי */
export function isIndexableSite(env: { NODE_ENV?: string; RENDER_EXTERNAL_HOSTNAME?: string } = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  const host = env.RENDER_EXTERNAL_HOSTNAME?.toLowerCase();
  return !(host && NON_PRODUCTION_HOSTS.has(host));
}
