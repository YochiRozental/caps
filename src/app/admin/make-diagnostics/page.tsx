import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { isDiagnosticsAvailable } from "@/lib/payments/make-diagnostics";
import { resolveGrowTestLink } from "@/lib/payments/grow-sandbox-test-link";
import { MakeDiagnosticsClient } from "./client";
import { TestCheckoutCard } from "./test-checkout";
import { VerifyV2DryRun } from "./verify-v2";

export const dynamic = "force-dynamic";

/** כלי אבחון זמני (Staging בלבד): ב-Production או כשלא הופעל - 404. הגישה למנהלים נאכפת ב-middleware ובנתיב ה-API */
export default async function MakeDiagnosticsPage() {
  const host = (await headers()).get("host")?.replace(/:\d+$/, "") ?? "";
  if (!isDiagnosticsAvailable(host)) notFound();
  const link = resolveGrowTestLink(host);
  return (
    <>
      <PageHeader eyebrow="Staging בלבד" title="אבחון תקשורת Make" subtitle="שליחת בקשת בדיקה עם נתוני דמה לתרחישי Make. לא מחייב, לא מאשר הזמנות ולא רוכש חבילות." />
      <TestCheckoutCard link={link} />
      <MakeDiagnosticsClient />
      <VerifyV2DryRun />
    </>
  );
}
