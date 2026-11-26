/**
 * שער משמרות קבועות. סגור כברירת מחדל: ללא SHIFTS_ENABLED=true אין הצגת אפשרות, אין יצירת משמרות ב-API, אין מעקב תשלומים חודשי,
 * ו-Cron העסקי אינו פועל; ההזמנות הרגילות ממשיכות כרגיל. גם כשהדגל פתוח, הזרימה פעילה רק אם יש ספק תשלום תקף בסביבה
 * (Grow ישירות או דרך Make); בלי ספק מוגדר היא נשארת סגורה. אין חיוב אוטומטי: תשלומי משמרות מתועדים ידנית.
 */
export function isShiftsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHIFTS_ENABLED === "true";
}
