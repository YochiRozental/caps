import { NextResponse } from "next/server";
import { runMonthlyShiftBilling } from "@/lib/shifts/billing";
import { gateProvider, mutationGuard, notFound, requireAdminUser, shiftErrorResponse } from "@/lib/shifts/http";

/**
 * הרצה ידנית של הריצה היומית של המשמרות (לבירור). אותה פונקציה בדיוק שה-Cron מריץ, ולכן אידמפוטנטית. אינה מחייבת דבר:
 * אין חיוב אוטומטי (תשלומי משמרות מתועדים ידנית). פעילה רק כשהשער פתוח; מנהל בלבד
 */
export async function POST(request: Request) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  try {
    return NextResponse.json(await runMonthlyShiftBilling({ trigger: "admin-manual" }));
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
