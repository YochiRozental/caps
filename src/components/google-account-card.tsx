"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Alert } from "@/components/ui";

/** קישור חשבון Google לחשבון קיים (דורש סיסמה), והגדרת סיסמה לחשבון שנוצר דרך Google */
export function GoogleAccountCard({ linked, hasPassword, googleEnabled }: { linked: boolean; hasPassword: boolean; googleEnabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch("/api/profile/google-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "שגיאה, נסו שוב");
      setLoading(false);
      return;
    }
    // בקישור לחשבון קיים תמיד בחירת חשבון מפורשת, כדי לא לקשר בטעות את חשבון Google שמחובר בדפדפן
    await signIn("google", { redirectTo: "/profile?google=linked" }, { prompt: "select_account" });
  }

  async function setNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch("/api/profile/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: password }),
    });
    setLoading(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "שגיאה, נסו שוב");
      return;
    }
    setPassword("");
    setMessage("הסיסמה הוגדרה. ניתן להתחבר גם עם אימייל וסיסמה.");
    router.refresh();
  }

  if (!googleEnabled && !linked) return null;

  return (
    <section className="card p-5 mb-6" aria-labelledby="google-account-title">
      <h2 id="google-account-title" className="font-display font-bold text-stone-900">חשבון Google</h2>
      {message && <div className="mt-3"><Alert tone="success">{message}</Alert></div>}
      {error && <div className="mt-3"><Alert tone="error">{error}</Alert></div>}
      {linked ? (
        <p className="text-sm text-stone-500 mt-2">חשבון Google מקושר, ואפשר להתחבר איתו.</p>
      ) : (
        <form onSubmit={link} className="mt-3 space-y-3">
          <p className="text-sm text-stone-500">לקישור חשבון Google יש להזין את סיסמת האתר לאימות.</p>
          <label htmlFor="google-link-password" className="field-label">סיסמה</label>
          <input id="google-link-password" required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="field" />
          <button type="submit" disabled={loading} className="btn btn-primary btn-sm">{loading ? "מעביר ל-Google..." : "קישור חשבון Google"}</button>
        </form>
      )}
      {linked && !hasPassword && (
        <form onSubmit={setNewPassword} className="mt-4 space-y-3 border-t border-stone-100 pt-4">
          <p className="text-sm text-stone-500">אין לחשבון סיסמה. הגדרת סיסמה תאפשר גם התחברות רגילה ופעולות הדורשות אימות סיסמה.</p>
          <label htmlFor="google-set-password" className="field-label">סיסמה חדשה</label>
          <input id="google-set-password" required minLength={4} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="field" />
          <button type="submit" disabled={loading} className="btn btn-primary btn-sm">הגדרת סיסמה</button>
        </form>
      )}
    </section>
  );
}
