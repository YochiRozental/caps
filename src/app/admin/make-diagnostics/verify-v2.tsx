"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui";

interface PaymentRow {
  id: string;
  createdAt: string;
  status: string;
  hours: number | null;
  amountAgorot: number;
  hasPackage: boolean;
}
interface PaidRow {
  transactionId: string;
  amountAgorot: number;
  amountMatches: boolean;
  owner: "free" | "this" | "other";
}
interface Result {
  ok: boolean;
  durationMs: number;
  payment: PaymentRow;
  error?: string;
  responseFormat?: "v2" | "legacy";
  transactionCount?: number;
  statusCodes?: string[];
  paid?: PaidRow[];
  refundCount?: number;
  linkIdVerified?: boolean;
  amountMatches?: boolean | null;
  decision?: string;
}

const STATUS_TEXT: Record<string, string> = { "0": "לא שולם", "2": "שולם", "4": "בוטל לפני שידור", "6": "החזר", "9": "נדחה" };
const OWNER_TEXT = { free: "לא משויכת עדיין", this: "משויכת לרכישה הזו", other: "משויכת לרכישה אחרת!" };
const shekels = (a: number) => `${(a / 100).toFixed(2)} ₪`;

/** בדיקה יבשה של Verify v2: קריאה בלבד. לא משנה תשלום, לא מפעיל חבילה, לא מאשר עסקה ולא שולח מייל */
export function VerifyV2DryRun() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    fetch("/api/admin/make-diagnostics/verify-v2")
      .then((r) => r.json())
      .then((d) => {
        setConfigured(!!d.configured);
        setPayments(d.payments ?? []);
        if (d.payments?.[0]) setSelected(d.payments[0].id);
      })
      .catch(() => setError("טעינת הרכישות נכשלה"));
  }, []);

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/admin/make-diagnostics/verify-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "הבקשה נכשלה");
      else setResult(data.result as Result);
    } catch {
      setError("הבקשה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 p-4 space-y-3 max-w-2xl">
      <h2 className="font-semibold">בדיקה יבשה: Verify v2 (קריאה בלבד)</h2>
      <p className="text-sm text-stone-600">
        שולח רכישת חבילה קיימת לתרחיש Verify v2 ומציג מה המערכת הייתה מחליטה. לא משנה תשלום, לא מפעיל חבילה, לא מאשר עסקה ב-Grow ולא שולח מייל.
        האתר ממשיך להשתמש בתרחיש האימות הקיים.
      </p>
      {configured === false && <Alert tone="error">תרחיש v2 אינו מוגדר: יש להוסיף ב-Render את MAKE_VERIFY_V2_WEBHOOK_URL ו-MAKE_VERIFY_V2_API_KEY.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <select value={selected} onChange={(e) => setSelected(e.target.value)} className="field max-w-md" aria-label="רכישה לבדיקה">
          {payments.length === 0 && <option value="">אין רכישות חבילה</option>}
          {payments.map((p) => (
            <option key={p.id} value={p.id}>
              {new Date(p.createdAt).toLocaleString("he-IL")} · {p.hours} שעות · {shekels(p.amountAgorot)} · {p.status}
              {p.hasPackage ? " · הופעלה" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="btn-primary" disabled={!configured || !selected || busy} onClick={run}>
          {busy ? "בודק..." : "הרצת בדיקה"}
        </button>
      </div>
      {result && (
        <div className="text-sm space-y-2" aria-live="polite">
          {!result.ok ? (
            <Alert tone="error">
              התשובה נדחתה: {result.error} · {result.durationMs}ms
            </Alert>
          ) : (
            <>
              <Alert tone={result.responseFormat === "v2" ? "success" : "error"}>
                תשובת JSON אחת, מבנה {result.responseFormat === "v2" ? "v2 (כל העסקאות)" : "legacy (עסקה אחת בלבד) - זה עדיין התרחיש הישן"} · {result.durationMs}ms
              </Alert>
              <p>
                עסקאות: <strong>{result.transactionCount}</strong>
                {result.statusCodes && result.statusCodes.length > 0 && <> · סטטוסים: {result.statusCodes.map((c) => `${c} (${STATUS_TEXT[c] ?? "לא מוכר"})`).join(", ")}</>}
                {result.refundCount ? <> · החזרים: {result.refundCount}</> : null}
              </p>
              {result.paid && result.paid.length > 0 && (
                <ul className="list-disc pr-5">
                  {result.paid.map((t) => (
                    <li key={t.transactionId}>
                      עסקה {t.transactionId}: {shekels(t.amountAgorot)} · סכום {t.amountMatches ? "תואם" : "לא תואם"} · {OWNER_TEXT[t.owner]}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                מזהה הקישור של Grow: {result.linkIdVerified ? "נבדק ותואם בכל עסקה ששולמה/הוחזרה" : "לא נבדק (אין שדה במבנה הישן)"}
                {result.amountMatches !== null && <> · סכום: {result.amountMatches ? "תואם" : "לא תואם"}</>}
              </p>
              <Alert tone="success">ההחלטה שהמערכת הייתה מקבלת: {result.decision}</Alert>
            </>
          )}
        </div>
      )}
    </section>
  );
}
