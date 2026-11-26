"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AuthShell, SectionTitle } from "@/components/ui";

type Props = {
  nextPath: string;
  isEdit?: boolean;
  initial: {
    firstName: string;
    lastName: string;
    phone: string;
    idNumber: string;
    gender: string;
  };
};

export function CompleteProfileForm({
  nextPath,
  isEdit = false,
  initial,
}: Props) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "שגיאה בשמירת הפרטים");
        setLoading(false);
        return;
      }

      // חזרה לתהליך ההזמנה המקורי — בחירת החדר והמועד נשמרת בדפדפן
      router.push(nextPath);
      router.refresh();
    } catch {
      setError("שגיאה בלתי צפויה, נסה שוב");
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={isEdit ? "עריכת פרטים" : "השלמת פרטים"}
      subtitle={
        isEdit
          ? "עדכון הפרטים האישיים שלך."
          : "כדי להזמין חדר יש להשלים את הפרטים הבאים. בחירת החדר והמועד נשמרת."
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <SectionTitle index="1">פרטים אישיים</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="cp-first-name" className="field-label">
              שם פרטי
            </label>
            <input
              id="cp-first-name"
              required
              autoComplete="given-name"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="cp-last-name" className="field-label">
              שם משפחה
            </label>
            <input
              id="cp-last-name"
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
            <label htmlFor="cp-phone" className="field-label">
              פלאפון
            </label>
            <input
              id="cp-phone"
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
            <label htmlFor="cp-id-number" className="field-label">
              מספר זהות
            </label>
            <input
              id="cp-id-number"
              required
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              pattern="\d{5,9}"
              title="מספר זהות בן 9 ספרות"
              value={form.idNumber}
              onChange={(e) =>
                setForm({
                  ...form,
                  idNumber: e.target.value.replace(/\D/g, ""),
                })
              }
              className="field text-right tabular-nums"
            />
          </div>
        </div>
        <div>
          <span className="field-label">מגדר</span>
          <div className="flex gap-6" role="radiogroup" aria-label="מגדר">
            {[
              { value: "MALE", label: "זכר" },
              { value: "FEMALE", label: "נקבה" },
            ].map((o) => (
              <label
                key={o.value}
                className="inline-flex items-center gap-2 text-sm text-stone-800 cursor-pointer"
              >
                <input
                  type="radio"
                  name="gender"
                  value={o.value}
                  checked={form.gender === o.value}
                  onChange={() => setForm({ ...form, gender: o.value })}
                />
                {o.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-stone-400 mt-1.5">נדרש להזמנת קליניקה</p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button
          type="submit"
          disabled={loading}
          className="btn btn-primary w-full py-3!"
        >
          {loading ? "שומר..." : isEdit ? "שמירה" : "שמירה והמשך להזמנה"}
        </button>
      </form>
    </AuthShell>
  );
}
