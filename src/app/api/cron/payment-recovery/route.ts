import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getFlowProvider } from "@/lib/payments/flow";
import { recoveryLogLine, runPaymentRecovery } from "@/lib/payments/recovery";

/**
 * התאוששות תשלומים ממתינים (ראו recovery.ts), למתזמן חיצוני (למשל Render Cron כל 10-15 דקות). כמו shift-billing:
 * מוגנת ב-CRON_SECRET (לפחות 24 תווים) ב-Authorization: Bearer, בהשוואה בזמן קבוע. בלי ספק תשלום פעיל או בלי סוד:
 * 404, כאילו אינה קיימת. הריצה אידמפוטנטית (אותו finalize כמו התראה), ולכן הפעלה כפולה או ניסיון חוזר בטוחים.
 * התשובה כוללת מספרים בלבד.
 */
const MIN_SECRET_LENGTH = 24;

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function POST(request: Request) {
  const provider = getFlowProvider();
  const secret = process.env.CRON_SECRET;
  if (!provider || !secret || secret.length < MIN_SECRET_LENGTH) return NextResponse.json({ error: "לא נמצא" }, { status: 404 });

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(digest(presented), digest(secret))) return NextResponse.json({ error: "אין הרשאה" }, { status: 401 });

  const started = performance.now();
  try {
    const summary = await runPaymentRecovery({ provider });
    console.log(recoveryLogLine(summary, performance.now() - started));
    return NextResponse.json({ status: "DONE", ...summary });
  } catch (err) {
    console.error("[payments] recovery failed", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "הריצה נכשלה" }, { status: 500 });
  }
}
