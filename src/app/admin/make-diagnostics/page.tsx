import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { isDiagnosticsAvailable } from "@/lib/payments/make-diagnostics";
import { MakeDiagnosticsClient } from "./client";

export const dynamic = "force-dynamic";

/** כלי אבחון זמני (Staging בלבד): ב-Production או כשלא הופעל - 404. הגישה למנהלים נאכפת ב-middleware ובנתיב ה-API */
export default async function MakeDiagnosticsPage() {
  const host = (await headers()).get("host")?.replace(/:\d+$/, "") ?? "";
  if (!isDiagnosticsAvailable(host)) notFound();
  return (
    <>
      <PageHeader eyebrow="Staging בלבד" title="אבחון תקשורת Make" subtitle="שליחת בקשת בדיקה עם נתוני דמה לתרחישי Make. לא מחייב, לא מאשר הזמנות ולא רוכש חבילות." />
      <MakeDiagnosticsClient />
    </>
  );
}
