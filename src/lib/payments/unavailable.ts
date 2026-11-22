import { NextResponse } from "next/server";
import { getRealProviderConfigProblem } from "@/lib/payments/config";
import { isStagingGateActive } from "@/lib/staging-gate/config";

/**
 * ספק אמיתי (make/grow) מוגדר אך התצורה שגויה: מחזירים 503 במקום 404/דילוג על התשלום. ההודעה המפורטת (שמות משתנים
 * בלבד) נרשמת בלוג השרת, ומוצגת בתשובה רק כששער ה-Staging פעיל (לא ב-Production).
 */
export function paymentUnavailableProblem(): string | null {
  const problem = getRealProviderConfigProblem();
  if (problem) console.error("[payments] provider misconfigured:", problem);
  return problem;
}

export function paymentUnavailableResponse(problem: string) {
  return NextResponse.json(
    {
      error: "התשלום אינו זמין כרגע, ההזמנה לא בוצעה",
      code: "PAYMENT_UNAVAILABLE",
      ...(isStagingGateActive("") ? { detail: problem } : {}),
    },
    { status: 503 },
  );
}
