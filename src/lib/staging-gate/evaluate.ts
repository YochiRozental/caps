import {
  isExemptPath,
  isServiceKeyAllowedPath,
  isStagingGateActive,
  isValidServiceKey,
  SERVICE_KEY_ALLOWED_PATHS,
  type ServiceKeyAllowedPaths,
  type StagingGateEnv,
} from "@/lib/staging-gate/config";
import { cookieMatchesPassword, serviceKeyMatches } from "@/lib/staging-gate/token";

export type StagingGateDecision = "inactive" | "exempt" | "allowed" | "denied";

export interface StagingGateRequest {
  hostname: string;
  pathname: string;
  cookieValue?: string | null;
  serviceKeyHeader?: string | null;
}

/**
 * מחזיר את ההחלטה עבור בקשה נתונה, בלי תלות ב-Next.js (פונקציה טהורה, נבדקת ישירות). ה-middleware וה-API
 * של ההתחברות הם רק "דבק" דק סביב הפונקציה הזו.
 *
 * סדר הבדיקה: קודם אם השער בכלל פעיל (תצורה תקינה + מארח לא-Production), אחר כך אם הנתיב פטור (עמוד/API
 * ההתחברות עצמם, נכסים ציבוריים), ולבסוף שני ערוצי אימות עצמאיים: מפתח שירות ייעודי (Make / שרת-לשרת),
 * המוגבל לרשימת נתיבי API מורשים בלבד (SERVICE_KEY_ALLOWED_PATHS - ריקה כרגע בכוונה), או עוגיית גישה
 * אנושית שתקפה לכל נתיב. מפתח השירות לעולם לא פותח עמודי אתר או את אזור הניהול - רק API ספציפי שאושר
 * במפורש. אף נתיב לא "עוקף" את השער בלי להציג אימות תקף כלשהו.
 */
export async function decideStagingGate(
  req: StagingGateRequest,
  env: StagingGateEnv = process.env as StagingGateEnv,
  serviceKeyAllowedPaths: ServiceKeyAllowedPaths = SERVICE_KEY_ALLOWED_PATHS
): Promise<StagingGateDecision> {
  if (!isStagingGateActive(req.hostname, env)) return "inactive";
  if (isExemptPath(req.pathname)) return "exempt";

  if (
    isServiceKeyAllowedPath(req.pathname, serviceKeyAllowedPaths) &&
    isValidServiceKey(env) &&
    (await serviceKeyMatches(req.serviceKeyHeader, env.STAGING_GATE_SERVICE_KEY))
  ) {
    return "allowed";
  }
  if (await cookieMatchesPassword(req.cookieValue, env.STAGING_GATE_PASSWORD)) {
    return "allowed";
  }
  return "denied";
}
