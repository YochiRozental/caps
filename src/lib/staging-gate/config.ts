/**
 * שער גישה לסביבת Staging בלבד (הכנה לחיבור Grow דרך Make). כבוי כברירת מחדל: בלי STAGING_GATE_ENABLED=true
 * מפורש השער לא פעיל כלל, בדיוק כמו שאין לו קוד (ראו תבנית CRON_SECRET ב-src/app/api/cron/shift-billing/route.ts).
 *
 * הגנה מפני הפעלה בטעות ב-Production: גם כש-STAGING_GATE_ENABLED=true וסיסמה תקנית מוגדרים, השער פועל רק אם
 * זהות הדיפלוי (RENDER_EXTERNAL_HOSTNAME, לא כותרת Host של הבקשה - ראו isKnownNonProductionHost למטה) מוכרת
 * כ"לא Production" (כתובת Staging הידועה, מארחים מקומיים, או הרחבה מפורשת דרך STAGING_GATE_EXTRA_HOSTS). כך
 * העתקה בטעות של משתני הסביבה לשירות ה-Production לא תחסום לקוחות אמיתיים, וגם לא ניתן לעקוף או להפעיל את
 * השער ע"י זיוף כותרת Host בבקשה עצמה.
 */

export interface StagingGateEnv {
  STAGING_GATE_ENABLED?: string;
  STAGING_GATE_PASSWORD?: string;
  STAGING_GATE_SERVICE_KEY?: string;
  STAGING_GATE_EXTRA_HOSTS?: string;
  /** מוזרק אוטומטית ע"י Render לכל שירות (לא חלק מהבקשה הנכנסת) - לעולם לא לקבוע ידנית */
  RENDER_EXTERNAL_HOSTNAME?: string;
}

/** כתובת שירות ה-Staging הידועה (ציבורית, לא סוד) — קבועה בקוד ולא ניתנת לשינוי דרך משתני סביבה */
const KNOWN_STAGING_HOSTS = new Set(["caps-staging-ppb1.onrender.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SERVICE_KEY_LENGTH = 24;

/** שם עוגיית הגישה. קידומת __Host- אוכפת Secure+Path=/ וחוסמת הגדרה מצד שרתים אחרים באותו דומיין-על */
export const GATE_COOKIE_NAME = "__Host-staging-gate";
export const GATE_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** כותרת ייעודית לאימות שרת-לשרת (Make, webhooks עתידיים) — נפרדת מהסיסמה האנושית, לא נשלחת בדפדפן */
export const SERVICE_KEY_HEADER = "x-staging-service-key";

export const LOGIN_PAGE_PATH = "/staging-login";
export const LOGIN_API_PATH = "/api/staging-gate/login";

/** נתיבי נכסים ציבוריים לא-רגישים (לוגו), כדי שעמוד הכניסה עצמו יוכל להיטען */
const PUBLIC_ASSET_PREFIXES = ["/brand/"];

export type ServiceKeyAllowedPaths = RegExp[];

/**
 * נתיבי API שמורשים לעבור אימות שרת-לשרת (מפתח שירות) בלבד - לעולם לא עמודי אתר, ולעולם לא /admin. ריקה
 * בכוונה כרגע: אין עדיין נתיב Make מסוים ומאושר (התרחיש עדיין לא נבדק). יש להוסיף לרשימה הזו נתיב-נתיב,
 * במפורש, כש-תרחיש ה-Make הסופי נקבע - ולעולם לא תבנית גורפת כמו /^\/api\//. עד אז מפתח השירות לא פותח
 * שום נתיב, כדי שלא יהפוך בטעות לעקיפה כללית של ההגנה.
 */
export const SERVICE_KEY_ALLOWED_PATHS: ServiceKeyAllowedPaths = [];

export function isServiceKeyAllowedPath(pathname: string, allowedPaths: ServiceKeyAllowedPaths = SERVICE_KEY_ALLOWED_PATHS): boolean {
  return allowedPaths.some((re) => re.test(pathname));
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/:\d+$/, "");
}

function extraHosts(env: StagingGateEnv): string[] {
  return (env.STAGING_GATE_EXTRA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * true אם המארח ידוע כ"לא Production" (Staging הידוע, מקומי, או הרחבה מפורשת).
 *
 * חשוב: כש-הדיפלוי רץ על Render, הזהות נקבעת לפי RENDER_EXTERNAL_HOSTNAME - משתנה שה-platform עצמו מזריק
 * לתוך הסביבה של השירות, ולא לפי hostname הבקשה הנכנסת. זה קריטי: hostname של הבקשה (כותרת Host) נשלח
 * ע"י הלקוח ולכן ניתן לזיוף - תוקף שישלח בקשה ישירות לשירות ה-Staging עם כותרת Host מזויפת היה יכול, אם
 * ההחלטה הייתה מתבססת על הבקשה, "לכבות" את השער על Staging האמיתי בלי שום אימות. הבקשה עצמה (hostname)
 * משמשת רק כ-fallback למצב פיתוח מקומי, שבו RENDER_EXTERNAL_HOSTNAME כלל לא קיים.
 */
export function isKnownNonProductionHost(hostname: string, env: StagingGateEnv): boolean {
  const renderHost = env.RENDER_EXTERNAL_HOSTNAME ? normalizeHost(env.RENDER_EXTERNAL_HOSTNAME) : null;
  if (renderHost !== null) {
    return KNOWN_STAGING_HOSTS.has(renderHost) || extraHosts(env).includes(renderHost);
  }
  // לא רץ על Render בכלל (אין את המשתנה) - ייתכן פיתוח מקומי בלבד, ואז מגבילים ל-localhost
  return LOCAL_HOSTS.has(normalizeHost(hostname));
}

/** תצורה תקינה בלבד (בלי קשר למארח): דגל מפורש + סיסמה בעלת אורך מינימלי */
export function isStagingGateConfigured(env: StagingGateEnv): boolean {
  return env.STAGING_GATE_ENABLED === "true" && !!env.STAGING_GATE_PASSWORD && env.STAGING_GATE_PASSWORD.length >= MIN_PASSWORD_LENGTH;
}

/** השער פעיל בפועל עבור הבקשה הזו: תצורה תקינה וגם מארח מוכר כלא-Production */
export function isStagingGateActive(hostname: string, env: StagingGateEnv = process.env as StagingGateEnv): boolean {
  return isStagingGateConfigured(env) && isKnownNonProductionHost(hostname, env);
}

export function isValidServiceKey(env: StagingGateEnv): boolean {
  return !!env.STAGING_GATE_SERVICE_KEY && env.STAGING_GATE_SERVICE_KEY.length >= MIN_SERVICE_KEY_LENGTH;
}

/** נתיבים שתמיד מותרים כש-השער פעיל: מנגנון ההתחברות לשער עצמו, ונכסים ציבוריים לא-רגישים */
export function isExemptPath(pathname: string): boolean {
  if (pathname === LOGIN_PAGE_PATH || pathname === LOGIN_API_PATH) return true;
  return PUBLIC_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * בונה כתובת-מקור (origin) ציבורית ומהימנה להפניות (redirect) של שער ה-Staging - בלי להתבסס על Host הבקשה
 * הנכנסת. מאחורי ה-Proxy הפנימי של Render, הבקשה שמגיעה לשרת עצמו (request.url) עשויה לשקף כתובת פנימית
 * (למשל http://localhost:10000) שהדפדפן של המשתמש לא יכול להגיע אליה בכלל - זו הייתה התקלה בפועל. הפתרון:
 * כש-RENDER_EXTERNAL_HOSTNAME קיים (מוזרק אוטומטית ע"י Render, אותו משתנה-מהימן ששימש להחלטה אם השער פעיל
 * ב-isKnownNonProductionHost למעלה - לא שדה סביבה נוסף שצריך להגדיר/לתחזק בנפרד) בונים ממנו את המקור, תמיד
 * דרך https. בפיתוח מקומי (אין את המשתנה כלל - אין Proxy באמצע) request.url כבר משקף נכון את הכתובת.
 */
export function resolveTrustedPublicOrigin(env: StagingGateEnv, requestUrl: string): string {
  if (env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${normalizeHost(env.RENDER_EXTERNAL_HOSTNAME)}`;
  }
  return new URL(requestUrl).origin;
}

/**
 * בונה כתובת מוחלטת לנתיב פנימי של שער ה-Staging, על בסיס המקור המהימן למעלה. הגנה כפולה מפני Open Redirect:
 * גם הקוראים אמורים להעביר רק נתיב פנימי שעבר כבר safeInternalPath, וגם כאן - אם בכל זאת הנתיב שהועבר הוא
 * בעצמו כתובת מוחלטת (כמו "https://evil.com", ש-new URL(path, origin) "בורחת" אליה ומתעלמת מה-origin) -
 * חוזרים לעמוד ההתחברות הבטוח של השער במקום להפנות לכתובת החיצונית.
 */
export function buildStagingUrl(internalPath: string, env: StagingGateEnv, requestUrl: string): URL {
  const origin = resolveTrustedPublicOrigin(env, requestUrl);
  const url = new URL(internalPath, origin);
  return url.origin === origin ? url : new URL(LOGIN_PAGE_PATH, origin);
}
