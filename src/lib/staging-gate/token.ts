/**
 * השוואה בזמן קבוע דרך Web Crypto (crypto.subtle), כמו ב-CRON_SECRET (src/app/api/cron/shift-billing/route.ts)
 * אך בלי תלות ב-node:crypto, כדי שהקובץ ירוץ גם ב-Edge Runtime של ה-middleware. גיבוב שני הצדדים ל-SHA-256 מנרמל
 * את האורך (32 בתים קבוע) כך שגם אורך הסוד המקורי לא נחשף בזמן ההשוואה.
 */
async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function secureEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/**
 * ערך עוגיית הגישה: גיבוב חד-כיווני של הסיסמה (עם מרחב-שמות ייעודי), לא הסיסמה עצמה. מתעדכן אוטומטית
 * כשהסיסמה מתחלפת (כל העוגיות הקיימות מפסיקות להיות תקפות), בלי לשמור שום מצב במסד הנתונים.
 */
export function gateCookieValue(password: string): Promise<string> {
  return sha256Hex(`staging-gate-cookie:${password}`);
}

export async function cookieMatchesPassword(presented: string | null | undefined, password: string | undefined): Promise<boolean> {
  if (!presented || !password) return false;
  return secureEqual(presented, await gateCookieValue(password));
}

export async function passwordMatches(presented: string, password: string | undefined): Promise<boolean> {
  if (!presented || !password) return false;
  return secureEqual(presented, password);
}

export async function serviceKeyMatches(presented: string | null | undefined, serviceKey: string | undefined): Promise<boolean> {
  if (!presented || !serviceKey) return false;
  return secureEqual(presented, serviceKey);
}
