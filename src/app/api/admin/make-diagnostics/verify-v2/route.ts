import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getFlowProvider, requireAdminUser } from "@/lib/payments/flow";
import type { DiagRequest } from "@/lib/payments/make-diagnostics";
import { handleDryRunGet, handleDryRunPost, type DryRunEnv, type DryRunPayment } from "@/lib/payments/verify-dry-run";

/**
 * בדיקה יבשה של תרחיש Verify v2 (Staging בלבד, מנהל בלבד, קריאה בלבד). הלוגיקה והאבטחה ב-src/lib/payments/verify-dry-run.ts;
 * כאן רק חיבור ל-Next ולמסד (קריאות בלבד). ב-Production ובכל סביבה שבה הכלי לא הופעל - 404 לפני כל בדיקת הרשאה.
 */
const authorize: DiagRequest["authorize"] = async () => {
  const admin = await requireAdminUser();
  if (!("response" in admin)) return "ok";
  return admin.response.status === 401 ? "unauthenticated" : "forbidden";
};

const select = {
  id: true,
  purpose: true,
  status: true,
  provider: true,
  providerPaymentId: true,
  amountAgorot: true,
  packageHours: true,
  createdAt: true,
  hoursPackage: { select: { id: true } },
} as const;

type Row = { hoursPackage: { id: string } | null } & Omit<DryRunPayment, "hasPackage">;
const toPayment = ({ hoursPackage, ...p }: Row): DryRunPayment => ({ ...p, hasPackage: hoursPackage !== null });

const loadPayment = async (id: string) => {
  const row = await prisma.payment.findUnique({ where: { id }, select });
  return row ? toPayment(row as Row) : null;
};

const listRecent = async () => {
  const rows = await prisma.payment.findMany({
    where: { purpose: "PACKAGE", provider: "make-grow", providerPaymentId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 15,
    select,
  });
  return rows.map((r) => toPayment(r as Row));
};

export async function GET(request: Request) {
  const r = await handleDryRunGet({ hostname: new URL(request.url).hostname, env: process.env as DryRunEnv, authorize, listRecent });
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const r = await handleDryRunPost({
    hostname: new URL(request.url).hostname,
    contentType: request.headers.get("content-type"),
    rawBody: (await request.text()).slice(0, 512),
    env: process.env as DryRunEnv,
    authorize,
    provider: getFlowProvider(),
    loadPayment,
    listRecent,
  });
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
