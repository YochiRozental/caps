import { NextResponse } from "next/server";
import { getMyShifts } from "@/lib/shifts/views";
import { gateProvider, notFound, requireClient, shiftErrorResponse } from "@/lib/shifts/http";

/**
 * המשמרות שלי: רשימה וזכאות. הנתיב קיים רק כשהשער פתוח (404 אחרת) ומחזיר נתוני המשתמש עצמו בלבד.
 * אין יצירת משמרת ע"י הלקוח: משמרת קבועה נקבעת ע"י ההנהלה ומשולמת בתשלום ידני (אין כרטיס שמור ואין חיוב אוטומטי).
 */
export async function GET() {
  if (!gateProvider()) return notFound();
  const authed = await requireClient();
  if (authed.response) return authed.response;
  try {
    return NextResponse.json(await getMyShifts({ userId: authed.user.id }));
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
