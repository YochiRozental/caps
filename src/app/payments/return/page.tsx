"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildReturnMessage, returnPageAction } from "@/lib/payments/embedded-checkout";

/**
 * דף החזרה מ-Grow (successUrl/cancelUrl של רכישת חבילה). הדף אינו מאשר דבר ואינו פונה לשרת התשלומים:
 *  - בתוך חלונית התשלום (iframe): שולח לחלון המארח "חזרנו מ-Grow", והוא מבקש מהשרת לאמת את הסטטוס.
 *  - בחלון חיצוני שנפתח מהאתר: מודיע לחלון הפותח ומנסה להיסגר.
 *  - אחרת (מעבר רגיל): חוזר לדף החבילות, שממשיך את האימות מול השרת.
 * ההודעה נשלחת רק ל-origin של האתר עצמו, והמקבל מאמת גם origin וגם מקור (ראו parseReturnMessage).
 */
export default function PaymentReturnPage() {
  const [action, setAction] = useState<"pending" | "notify-parent" | "notify-opener" | "redirect">("pending");

  useEffect(() => {
    const inIframe = window.parent !== window;
    const opener = window.opener as Window | null;
    const next = returnPageAction({ inIframe, hasOpener: !!opener && !opener.closed });
    const message = buildReturnMessage(window.location.search);
    const origin = window.location.origin;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ההחלטה תלויה בהקשר החלון, שידוע רק בדפדפן
    setAction(next);
    if (next === "notify-parent") {
      window.parent.postMessage(message, origin);
    } else if (next === "notify-opener" && opener) {
      opener.postMessage(message, origin);
      window.setTimeout(() => window.close(), 400);
    } else {
      window.location.replace("/profile/hours");
    }
  }, []);

  return (
    <div className="max-w-md mx-auto">
      <div className="card p-6 sm:p-8 text-center space-y-3" role="status" aria-live="polite">
        <span className="mx-auto w-10 h-10 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin block" aria-hidden="true" />
        <h1 className="font-display text-xl font-bold text-stone-900">בודקים את התשלום...</h1>
        <p className="text-sm text-stone-600">
          החבילה תופעל רק לאחר שהמערכת תקבל אישור תשלום מאומת. אין צורך לשלם שוב.
        </p>
        {action === "notify-opener" && <p className="text-sm text-stone-500">אפשר לסגור את החלון הזה ולחזור לאתר.</p>}
        {action !== "notify-parent" && (
          <Link href="/profile/hours" className="btn btn-secondary btn-sm inline-flex">
            מעבר לחבילות השעות
          </Link>
        )}
      </div>
    </div>
  );
}
