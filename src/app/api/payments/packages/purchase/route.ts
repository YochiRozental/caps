import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { startPackagePurchase } from "@/lib/payments/packages";
import { errorResponse, getFlowProvider, notFound, withoutProviderInternals } from "@/lib/payments/flow";
import { handlePackagePing, isPackagePingAvailable, type PackagePingEnv } from "@/lib/payments/make-diagnostics";
import { findHoursPackage } from "@/lib/payments/pricing";
import { getRegularPricing, hoursPackageOptions } from "@/lib/payments/pricing-db";

/**
 * פתיחת רכישת חבילה. נקלטים רק מספר השעות ומפתח אידמפוטנטיות; המחיר נקבע בשרת. החבילה נוצרת רק אחרי שהתשלום
 * אומת בצד השרת (GET /api/payments/[id] או webhook). כשאין ספק מוגדר הנתיב מחזיר 404.
 *
 * חריג זמני ל-Staging בלבד (MAKE_PACKAGE_PING_ENABLED): חבילת 5 שעות שולחת בדיקת תקשורת ל-Make ותו לא - בלי Payment,
 * בלי ספק תשלום ובלי זיכוי שעות (ראו handlePackagePing ב-make-diagnostics.ts). בכל מקרה אחר הזרימה ללא שינוי.
 */
export async function POST(request: Request) {
  const hostname = new URL(request.url).hostname;
  if (isPackagePingAvailable(hostname)) {
    const session = await auth();
    const ping = await handlePackagePing({
      hostname,
      rawBody: (await request.clone().text()).slice(0, 2048),
      env: process.env as PackagePingEnv,
      userId: session?.user?.id ?? null,
      loadUser: (id) => prisma.user.findUnique({ where: { id }, select: { role: true, status: true } }),
      loadPackagePriceAgorot: async (hours) => findHoursPackage(hours, hoursPackageOptions(await getRegularPricing()))?.priceAgorot ?? null,
    });
    if (ping) return NextResponse.json(ping.body, { status: ping.status, headers: { "Cache-Control": "no-store" } });
  }

  const provider = getFlowProvider();
  if (!provider) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const hours = Number(body?.hours);
  const clientKey = typeof body?.clientKey === "string" ? body.clientKey : "";
  if (!Number.isInteger(hours)) return NextResponse.json({ error: "חבילה לא תקינה" }, { status: 400 });

  try {
    const started = await startPackagePurchase({ userId: session.user.id, hours, clientKey, provider });
    return NextResponse.json(withoutProviderInternals(started, provider));
  } catch (err) {
    return errorResponse(err);
  }
}
