"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Alert, AuthShell } from "@/components/ui";
import { GoogleButton } from "@/components/google-button";
import { googleErrorMessage } from "@/lib/google-errors";
import { safeInternalPath } from "@/lib/safe-path";

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  idNumber: "",
  password: "",
};

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl");
  const googleError = googleErrorMessage(searchParams.get("error"));
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "שגיאה בהרשמה");
        setLoading(false);
        return;
      }

      const signInResult = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
        redirectTo: safeInternalPath(callbackUrl, "/account-status"),
      });

      if (signInResult?.error) {
        router.push("/login");
        return;
      }

      // מגיעים מתהליך הזמנה — חוזרים אליו; אחרת למסך הסטטוס
      router.push(safeInternalPath(callbackUrl, "/account-status"));
      router.refresh();
    } catch {
      setError("שגיאה בלתי צפויה, נסה שוב");
      setLoading(false);
    }
  }

  return (
    <AuthShell title="הרשמה למערכת" subtitle="שדות המסומנים בכוכבית (*) הם שדות חובה">
      {googleError && (
        <div className="mb-5">
          <Alert tone="error">{googleError}</Alert>
        </div>
      )}
      <GoogleButton
        label="הרשמה עם Google"
        callbackUrl={`/complete-profile?next=${encodeURIComponent(safeInternalPath(callbackUrl, "/account-status"))}`}
      />
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="reg-first-name" className="field-label">שם פרטי *</label>
            <input
              id="reg-first-name"
              required
              autoComplete="given-name"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="reg-last-name" className="field-label">שם משפחה *</label>
            <input
              id="reg-last-name"
              required
              autoComplete="family-name"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="field"
            />
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="reg-phone" className="field-label">פלאפון *</label>
            <input
              id="reg-phone"
              required
              type="tel"
              dir="ltr"
              autoComplete="tel"
              placeholder="050-1234567"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="field text-right"
            />
          </div>
          <div>
            <label htmlFor="reg-id-number" className="field-label">מספר זהות *</label>
            <input
              id="reg-id-number"
              required
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              pattern="\d{5,9}"
              title="מספר זהות בן 9 ספרות"
              value={form.idNumber}
              onChange={(e) => setForm({ ...form, idNumber: e.target.value.replace(/\D/g, "") })}
              className="field text-right tabular-nums"
            />
          </div>
        </div>
        <div>
          <label htmlFor="reg-email" className="field-label">אימייל *</label>
          <input
            id="reg-email"
            required
            type="email"
            dir="ltr"
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="field text-right"
          />
        </div>
        <div>
          <label htmlFor="reg-password" className="field-label">סיסמה *</label>
          <input
            id="reg-password"
            required
            type="password"
            minLength={4}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="field"
          />
          <p className="text-xs text-stone-400 mt-1.5">לפחות 4 תווים</p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button type="submit" disabled={loading} className="btn btn-primary w-full py-3!">
          {loading ? "נרשם..." : "הרשמה"}
        </button>

        <p className="text-sm text-stone-500 text-center">
          כבר יש לך חשבון?{" "}
          <Link
            href={callbackUrl ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/login"}
            className="text-brand-700 font-semibold hover:underline"
          >
            התחברות
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
