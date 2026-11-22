"use client";

import { useState } from "react";
import { Alert } from "@/components/ui";

type Scenario = "create" | "verify";
interface Result {
  scenario: Scenario;
  outcome: string;
  httpStatus?: number;
  durationMs: number;
  responseFields?: string[];
  hasUrlField?: boolean;
  hints?: string[];
  warnings?: string[];
}

const LABELS: Record<Scenario, string> = { create: "יצירת קישור תשלום (Create Payment Link)", verify: "אימות תשלום (Verify Payment)" };
const OUTCOMES: Record<string, string> = {
  SUCCESS: "הצלחה: Make השיב JSON",
  ACCEPTED_NO_RESPONSE: "Make קלט את הבקשה (בלי Webhook response) - תקין לגילוי שדות",
  NOT_LISTENING: "אין תרחיש מאזין ב-Make (410)",
  AUTH_FAILED: "כשל אימות (x-make-apikey)",
  MAKE_ERROR: "שגיאה מ-Make",
  TIMEOUT: "חריגה מהזמן",
  NETWORK_ERROR: "שגיאת רשת",
  BAD_RESPONSE: "תשובה לא תקינה",
};

export function MakeDiagnosticsClient() {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<Scenario | null>(null);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Partial<Record<Scenario, Result>>>({});

  async function run(scenario: Scenario) {
    setBusy(scenario);
    setError("");
    try {
      const res = await fetch("/api/admin/make-diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, confirmStopsBeforeGrow: confirmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "הבקשה נכשלה");
      else setResults((r) => ({ ...r, [scenario]: data.result as Result }));
    } catch {
      setError("הבקשה נכשלה");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
        <span>אישרתי שבתרחישי Make קיים פילטר שעוצר לפני מודול Grow כאשר השדה diagnostic שווה DISCOVER (או שהתרחיש במצב הרצה חד-פעמית לגילוי שדות).</span>
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      {(["create", "verify"] as const).map((s) => {
        const r = results[s];
        return (
          <section key={s} className="rounded-xl border border-stone-200 p-4 space-y-3">
            <h2 className="font-semibold">{LABELS[s]}</h2>
            <button type="button" disabled={!confirmed || busy !== null} onClick={() => run(s)} className="btn-primary">
              {busy === s ? "שולח..." : "שליחת בקשת בדיקה"}
            </button>
            {r && (
              <div className="text-sm space-y-1" aria-live="polite">
                <Alert tone={["SUCCESS", "ACCEPTED_NO_RESPONSE"].includes(r.outcome) ? "success" : "error"}>
                  {OUTCOMES[r.outcome] ?? r.outcome}
                  {r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""} · {r.durationMs}ms
                </Alert>
                {r.responseFields && <p>שדות בתשובה: {r.responseFields.join(", ") || "אין"} · שדה url: {r.hasUrlField ? "קיים" : "חסר"}</p>}
                {r.warnings && <Alert tone="error">{r.warnings.join(" ")}</Alert>}
                {r.hints && <ul className="list-disc pr-5">{r.hints.map((h) => <li key={h}>{h}</li>)}</ul>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
