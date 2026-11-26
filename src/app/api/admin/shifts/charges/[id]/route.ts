import { NextResponse } from "next/server";
import { recordManualPayment, resolveUnknownCharge } from "@/lib/shifts/lifecycle";
import { gateProvider, int, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";

/**
 * טיפול מנהל בחיוב חודשי: תיעוד תשלום ידני שהתקבל בפועל (manual-payment: סכום, תאריך, אישור מפורש), או בירור של חיוב
 * ישן במצב "לא ידוע" (resolve-paid / resolve-not-charged). אין חיוב אוטומטי. תשלום ידני לא מסומן כשולם בלי confirm: true.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  const body = await readJson(request);
  const action = str(body?.action);
  try {
    if (action === "manual-payment") {
      return NextResponse.json(
        await recordManualPayment({
          chargeId: id,
          adminId: admin.user.id,
          amountAgorot: int(body?.amountAgorot) ?? Number.NaN,
          paidOn: str(body?.paidOn) ?? "",
          reference: str(body?.reference),
          confirm: body?.confirm === true,
        })
      );
    }
    if (action === "resolve-paid" || action === "resolve-not-charged") {
      return NextResponse.json(
        await resolveUnknownCharge({ chargeId: id, adminId: admin.user.id, outcome: action === "resolve-paid" ? "PAID" : "NOT_CHARGED", note: str(body?.note) })
      );
    }
    return NextResponse.json({ error: "פעולה לא תקינה" }, { status: 400 });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
