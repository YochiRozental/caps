import { NextResponse } from "next/server";
import { getFlowProvider, notFound } from "@/lib/payments/flow";
import { paymentUnavailableProblem, paymentUnavailableResponse } from "@/lib/payments/unavailable";

/**
 * שער ההפעלה של זרימת התשלום עבור הממשק. כשאין ספק תקף מחזיר 404, והממשק נשאר במסלול ההזמנה הקיים.
 * אינו חושף שום הגדרה או סוד.
 */
export async function GET() {
  const provider = getFlowProvider();
  if (!provider) {
    const unavailable = paymentUnavailableProblem();
    return unavailable ? paymentUnavailableResponse(unavailable) : notFound();
  }
  return NextResponse.json({ enabled: true });
}
