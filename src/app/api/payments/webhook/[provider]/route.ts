import { NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";
import { WebhookVerificationError } from "@/lib/payments/provider";
import { isTransientVerifyFailure } from "@/lib/payments/verify-errors";

/**
 * קליטת התראות ספק. ללא סשן: האימות הוא חתימת ה-webhook בלבד, וגם אחריה הסטטוס נשלף מחדש מהספק.
 * כשאין ספק מוגדר (כל סביבה חיה כרגע) הנתיב מחזיר 404.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = getFlowProvider();
  const { provider: name } = await params;
  if (!provider || provider.name !== name) return notFound();

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const result = await handlePaymentWebhook({ provider, rawBody, headers, query });
    // תיעוד קבלת התראה (בלי גוף, חתימה או פרטי לקוח): מאפשר לדעת אם Grow אכן שלח, גם בלי Request Logs
    console.log(`[payments] notify ${name} outcome=${result.outcome} finalize=${result.finalize?.outcome ?? "-"}`);
    // DEFERRED: התשלום עדיין לא ידוע אצלנו; 202 מבקש מהספק לנסות שוב
    return NextResponse.json({ outcome: result.outcome }, { status: result.outcome === "DEFERRED" ? 202 : 200 });
  } catch (err) {
    if (err instanceof WebhookVerificationError) console.warn(`[payments] notify ${name} rejected: ${err.message.slice(0, 120)}`);
    // תקלה זמנית באימות: 503 כדי ש-Grow ישלח שוב, והאירוע נשאר לא-מעובד כדי שהשליחה הבאה תאמת מחדש
    if (isTransientVerifyFailure(err)) {
      console.error(`[payments] notify ${name} verify unavailable: ${err.message.slice(0, 200)}`);
      return NextResponse.json({ error: "verification unavailable" }, { status: 503 });
    }
    return errorResponse(err);
  }
}
