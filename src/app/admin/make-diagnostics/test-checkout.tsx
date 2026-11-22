import { Alert } from "@/components/ui";
import type { GrowTestLink } from "@/lib/payments/grow-sandbox-test-link";

/** כפתור "תשלום ניסיון ב-Grow": קישור פשוט לדף ה-Sandbox. לא יוצר הזמנה, חבילה, חיוב או רשומה במערכת */
export function TestCheckoutCard({ link }: { link: GrowTestLink }) {
  return (
    <section className="rounded-xl border border-stone-200 p-4 space-y-3 max-w-2xl mb-6">
      <h2 className="font-semibold">תשלום ניסיון ב-Grow (Sandbox)</h2>
      <p className="text-sm text-stone-500">פותח את דף התשלום של Grow Sandbox בלשונית חדשה. אין יצירת הזמנה, חבילה או חיוב בקפסולה. לבדיקות בלבד, לא לרכישה אמיתית.</p>
      {link.status === "ok" ? (
        <a href={link.url} target="_blank" rel="noopener noreferrer" className="btn-primary inline-block">
          תשלום ניסיון ב-Grow
        </a>
      ) : link.status === "invalid" ? (
        <Alert tone="error">הקישור שהוגדר ב-GROW_SANDBOX_TEST_CHECKOUT_URL נדחה: {link.reason}</Alert>
      ) : (
        <Alert tone="error">לא הוגדר קישור בדיקה. יש להגדיר GROW_SANDBOX_TEST_CHECKOUT_URL בסביבת Staging (קישור מ-Grow Sandbox).</Alert>
      )}
    </section>
  );
}
