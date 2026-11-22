import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/payments/flow";
import { handleDiagnosticsGet, handleDiagnosticsPost, type DiagEnv, type DiagRequest } from "@/lib/payments/make-diagnostics";

/**
 * אבחון תקשורת אתר -> Make (Staging בלבד, מנהל בלבד). כל הלוגיקה והאבטחה ב-src/lib/payments/make-diagnostics.ts;
 * כאן רק חיבור ל-Next. ב-Production (ובכל סביבה שבה הכלי לא הופעל) הנתיב מחזיר 404 לפני כל בדיקת הרשאה.
 */
const authorize: DiagRequest["authorize"] = async () => {
  const admin = await requireAdminUser();
  if (!("response" in admin)) return "ok";
  return admin.response.status === 401 ? "unauthenticated" : "forbidden";
};

export async function GET(request: Request) {
  const r = await handleDiagnosticsGet(new URL(request.url).hostname, process.env as DiagEnv, authorize);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const rawBody = (await request.text()).slice(0, 2048);
  const r = await handleDiagnosticsPost({
    hostname: new URL(request.url).hostname,
    contentType: request.headers.get("content-type"),
    rawBody,
    env: process.env as DiagEnv,
    authorize,
  });
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
