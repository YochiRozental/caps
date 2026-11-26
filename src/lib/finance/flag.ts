/**
 * שער הניהול הכספי (שלב H). סגור כברירת מחדל: בלי FINANCE_ADMIN_ENABLED=true אין מסכי ניהול כספי, אין נתיבי API חדשים
 * ואין פעולות כספיות חדשות; התנהגות שלבים A-G אינה משתנה. גם כשהדגל פתוח הוא פעיל רק עם ספק תשלום תקף בסביבה
 * (Grow ישירות או דרך Make); בלי ספק מוגדר הוא נשאר סגור.
 */
export function isFinanceAdminEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FINANCE_ADMIN_ENABLED === "true";
}
