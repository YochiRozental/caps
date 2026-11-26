"use client";

import { useEffect, useState } from "react";
import { getProviders, signIn } from "next-auth/react";

function GoogleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="w-5 h-5">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** כפתור ״המשך עם Google״ בהתאם להנחיות המיתוג של Google. מוצג רק כש-Google מוגדר בשרת */
export function GoogleButton({ callbackUrl, label = "המשך עם Google" }: { callbackUrl: string; label?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getProviders()
      .then((p) => setEnabled(!!p?.google))
      .catch(() => setEnabled(false));
  }, []);

  if (!enabled) return null;

  return (
    <div className="mb-6">
      <button
        type="button"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          void signIn("google", { redirectTo: callbackUrl });
        }}
        className="w-full flex items-center justify-center gap-3 rounded-xl border border-stone-300 bg-white py-3 px-4 text-sm font-semibold text-stone-800 hover:bg-stone-50 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <GoogleLogo />
        {loading ? "מעביר ל-Google..." : label}
      </button>
      <div className="flex items-center gap-3 mt-6 text-xs text-stone-400" aria-hidden="true">
        <span className="flex-1 h-px bg-stone-200" />
        או
        <span className="flex-1 h-px bg-stone-200" />
      </div>
    </div>
  );
}
