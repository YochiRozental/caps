import { isKnownNonProductionHost, type StagingGateEnv } from "@/lib/staging-gate/config";

export const SITE_URL = "https://caps.co.il";
export const SITE_NAME = "הקפסולה";
export const SITE_TITLE = "הקפסולה – קליניקות להשכרה לפי שעה במודיעין עילית";
export const SITE_DESCRIPTION =
  "הקפסולה מציעה קליניקות מעוצבות ומאובזרות להשכרה לפי שעה במודיעין עילית, חדר סדנאות, חדר המתנה ומטבחון מאובזר. הזמינו קליניקה בקלות ובאופן מקוון.";

/** אינדוקס מותר רק ב-Production: לא ב-Staging (Render), לא בפיתוח מקומי */
export function isIndexableSite(env: StagingGateEnv & { NODE_ENV?: string } = process.env as StagingGateEnv): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.RENDER_EXTERNAL_HOSTNAME && isKnownNonProductionHost("", env)) return false;
  return true;
}
