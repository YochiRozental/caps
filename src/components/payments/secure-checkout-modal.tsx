"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Icon } from "@/components/ui";
import { shekel } from "@/lib/payments/client";
import { CONFIRMATION_GRACE_MS, IFRAME_LOAD_TIMEOUT_MS, parseReturnMessage, type ReturnHint } from "@/lib/payments/embedded-checkout";

/**
 * חלונית "תשלום מאובטח": סיכום רכישה -> יצירת קישור (בשרת, דרך Make) -> דף התשלום של Grow בתוך iframe.
 * שדות האשראי קיימים אך ורק בדף של Grow (מקור אחר, מבודד מהאתר). החלונית לא מחליטה על הצלחה: היא מציגה את מה
 * שההורה (BuyTab) קיבל מאימות השרת. חזרה מה-iframe (הודעה מדף החזרה שלנו או טעינת דף מה-origin שלנו) רק מזרזת
 * בדיקת סטטוס בשרת.
 */

export type CheckoutPhase =
  /** סיכום הרכישה לפני יצירת תשלום */
  | "summary"
  /** יוצרים הזמנה וקישור תשלום */
  | "creating"
  /** דף Grow מוצג ב-iframe */
  | "checkout"
  /** דף Grow נפתח בחלון חיצוני; ממתינים לאישור שרת */
  | "external"
  /** חזרנו מ-Grow; ממתינים לאישור שרת */
  | "verifying";

export interface CheckoutModalProps {
  hours: number;
  amountAgorot: number;
  phase: CheckoutPhase;
  checkoutUrl?: string;
  error?: string | null;
  /** הודעת המתנה/ביטול שהגיעה מההורה */
  returnHint?: ReturnHint;
  sandbox?: boolean;
  onStart: () => void;
  onClose: () => void;
  /** חזרה מדף התשלום (רמז בלבד): ההורה מבקש מהשרת לאמת */
  onReturned: (hint: ReturnHint) => void;
  onOpenExternal: () => void;
  /** טעינה מחדש של דף התשלום (אחרי ביטול באמצע) */
  onReopen?: () => void;
  onCheckNow: () => void;
}

export function SecureCheckoutModal(props: CheckoutModalProps) {
  const { hours, amountAgorot, phase, checkoutUrl, error, returnHint, sandbox, onStart, onClose, onReturned, onOpenExternal, onReopen, onCheckNow } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameSlow, setFrameSlow] = useState(false);
  const [waitingLong, setWaitingLong] = useState(false);
  const returnedRef = useRef(onReturned);
  const closeRef = useRef(onClose);
  useEffect(() => {
    returnedRef.current = onReturned;
    closeRef.current = onClose;
  });

  // נעילת גלילת הרקע ומיקוד הכותרת בפתיחה
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    titleRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape סוגר (כמו כפתור הסגירה). בזמן יצירת הקישור לא סוגרים כדי לא לאבד את התשובה
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "creating") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  // הודעה מדף החזרה שלנו בתוך ה-iframe: מתקבלת רק מה-origin של האתר ומה-iframe הזה
  useEffect(() => {
    if (phase !== "checkout") return;
    const onMessage = (event: MessageEvent) => {
      const msg = parseReturnMessage(event, { origin: window.location.origin, sources: [iframeRef.current?.contentWindow] });
      if (msg) returnedRef.current(msg.hint);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [phase]);

  // דף Grow שלא נטען בזמן סביר: מציגים בבירור את האפשרות לחלון חיצוני
  useEffect(() => {
    if (phase !== "checkout") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- איפוס מצב הטעינה עם כל פתיחה של דף התשלום
    setFrameLoaded(false);
    setFrameSlow(false);
    const id = window.setTimeout(() => setFrameSlow(true), IFRAME_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [phase, checkoutUrl]);

  // אחרי חזרה: אם האישור מתעכב, מסבירים שאפשר לסגור והחבילה תופעל אוטומטית
  useEffect(() => {
    if (phase !== "verifying" && phase !== "external") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- איפוס מצב ההמתנה בכל כניסה למצב אימות
    setWaitingLong(false);
    const id = window.setTimeout(() => setWaitingLong(true), CONFIRMATION_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  function onFrameLoad() {
    setFrameLoaded(true);
    // דף מה-origin שלנו (דף החזרה, או כל דף אחר של האתר) נגיש לקריאה; דף Grow זורק SecurityError
    try {
      const href = iframeRef.current?.contentWindow?.location.href;
      if (href && href !== "about:blank" && href.startsWith(window.location.origin)) onReturned("unknown");
    } catch {
      // דף Grow (מקור אחר) - מצב תקין
    }
  }

  const wide = phase === "checkout";
  const perHour = hours > 0 ? Math.round(amountAgorot / hours) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-stone-900/55 backdrop-blur-[2px] sm:p-4"
      role="presentation"
      data-testid="secure-checkout"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="secure-checkout-title"
        className={`card w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-md"} rounded-b-none sm:rounded-b-[1.25rem] max-h-[100dvh] sm:max-h-[94vh] flex flex-col overflow-hidden`}
      >
        <header className="flex items-center justify-between gap-3 px-5 sm:px-6 pt-5 pb-4 border-b border-cream-100">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-full bg-brand-50 text-brand-700 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
              <Icon name="lock" className="w-4 h-4" />
            </span>
            <h2 id="secure-checkout-title" ref={titleRef} tabIndex={-1} className="font-display text-xl font-bold text-stone-900 outline-none">
              תשלום מאובטח
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={phase === "creating"}
            aria-label="סגירת חלונית התשלום"
            className="w-9 h-9 rounded-full flex items-center justify-center text-stone-500 hover:bg-cream-100 hover:text-stone-800 disabled:opacity-40"
          >
            <Icon name="x" className="w-5 h-5" />
          </button>
        </header>

        <div className="px-5 sm:px-6 py-3 bg-cream-50/70 border-b border-cream-100 flex items-center justify-between gap-3 text-sm" data-testid="checkout-summary">
          <div className="min-w-0">
            <p className="font-semibold text-stone-800">כרטיסיית {hours} שעות</p>
            <p className="text-xs text-stone-500">
              {shekel(perHour)} לשעה · תוקף שנה מיום הרכישה
            </p>
          </div>
          <div className="text-left shrink-0">
            <p className="text-xs text-stone-500">סכום לתשלום</p>
            <p className="font-display text-xl font-bold text-brand-700 tabular-nums">{shekel(amountAgorot)}</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-4">
          {error && <Alert tone="error">{error}</Alert>}

          {(phase === "summary" || phase === "creating") && (
            <>
              <ul className="text-sm text-stone-600 space-y-2">
                <li className="flex gap-2">
                  <Icon name="lock" className="w-4 h-4 mt-0.5 text-brand-600 shrink-0" />
                  התשלום מתבצע בדף המאובטח של Grow. פרטי האשראי אינם עוברים דרך האתר ואינם נשמרים בו.
                </li>
                <li className="flex gap-2">
                  <Icon name="check" className="w-4 h-4 mt-0.5 text-brand-600 shrink-0" />
                  השעות ייטענו לחשבון מיד לאחר קבלת אישור תשלום מאומת.
                </li>
                {sandbox && (
                  <li className="flex gap-2 text-bronze-700">
                    <Icon name="sparkle" className="w-4 h-4 mt-0.5 shrink-0" />
                    סביבת בדיקות: לא מתבצע חיוב אמיתי.
                  </li>
                )}
              </ul>
              {phase === "creating" && (
                <div className="flex items-center gap-3 rounded-xl bg-brand-50/60 border border-brand-100 px-4 py-3 text-sm text-brand-800" role="status">
                  <span className="w-4 h-4 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin shrink-0" aria-hidden="true" />
                  מכינים עבורכם דף תשלום מאובטח...
                </div>
              )}
            </>
          )}

          {phase === "checkout" && checkoutUrl && (
            <div className="space-y-3">
              <div className="relative rounded-xl overflow-hidden ring-1 ring-cream-200 bg-white">
                {!frameLoaded && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-stone-500" role="status">
                    <span className="w-4 h-4 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin" aria-hidden="true" />
                    טוענים את דף התשלום...
                  </div>
                )}
                <iframe
                  ref={iframeRef}
                  key={checkoutUrl}
                  src={checkoutUrl}
                  title="דף תשלום מאובטח של Grow"
                  onLoad={onFrameLoad}
                  // Google Pay דורש allow="payment"; אין sandbox כדי לא לשבור 3D Secure ו-Bit בתוך דף Grow
                  allow="payment"
                  referrerPolicy="strict-origin-when-cross-origin"
                  className="relative block w-full h-[60dvh] sm:h-[600px] border-0"
                  data-testid="checkout-iframe"
                />
              </div>
              {frameSlow && !frameLoaded && (
                <p role="status" className="rounded-xl px-4 py-3 text-sm bg-bronze-50 text-bronze-700 border border-bronze-200">
                  דף התשלום נטען לאט מהרגיל. אפשר להמשיך להמתין או לפתוח אותו בחלון חיצוני.
                </p>
              )}
              <p className="text-xs text-stone-500 flex flex-wrap items-center gap-x-1">
                דף התשלום לא מוצג כראוי?
                <button type="button" onClick={onOpenExternal} className="font-semibold text-brand-700 underline underline-offset-2">
                  פתיחה בחלון חיצוני
                </button>
              </p>
            </div>
          )}

          {(phase === "verifying" || phase === "external") && (
            <div className="text-center space-y-3 py-4" role="status" aria-live="polite">
              {returnHint === "cancel" ? (
                <>
                  <span className="mx-auto w-11 h-11 rounded-full bg-bronze-50 text-bronze-600 ring-1 ring-bronze-200 flex items-center justify-center">
                    <Icon name="ban" className="w-5 h-5" />
                  </span>
                  <p className="font-display text-lg font-bold text-stone-900">התשלום לא הושלם</p>
                  <p className="text-sm text-stone-600">לא נוספה יתרה. אפשר לחזור לדף התשלום או לסגור את החלונית.</p>
                </>
              ) : (
                <>
                  <span className="mx-auto w-11 h-11 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin block" aria-hidden="true" />
                  <p className="font-display text-lg font-bold text-stone-900">
                    {phase === "external" ? "ממתינים להשלמת התשלום בחלון החיצוני" : "מאמתים את התשלום..."}
                  </p>
                  <p className="text-sm text-stone-600">
                    השעות ייטענו לחשבון ברגע שיתקבל אישור תשלום מאומת. אין צורך לשלם שוב.
                  </p>
                  {waitingLong && (
                    <p className="text-sm text-bronze-700 bg-bronze-50 border border-bronze-200 rounded-xl px-4 py-3">
                      האישור מתעכב. אם השלמתם את התשלום אפשר לסגור את החלונית: החבילה תופעל אוטומטית כשהאישור יתקבל.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <footer className="px-5 sm:px-6 py-4 border-t border-cream-100 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          {(phase === "summary" || phase === "creating") && (
            <>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={phase === "creating"}>
                ביטול
              </button>
              <button type="button" className="btn btn-primary" onClick={onStart} disabled={phase === "creating"} data-testid="checkout-start">
                {phase === "creating" ? "מכינים תשלום..." : `מעבר לתשלום ${shekel(amountAgorot)}`}
              </button>
            </>
          )}
          {phase === "checkout" && (
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              סגירה
            </button>
          )}
          {(phase === "verifying" || phase === "external") && (
            <>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                סגירה
              </button>
              {returnHint === "cancel" && onReopen ? (
                <button type="button" className="btn btn-primary" onClick={onReopen}>
                  חזרה לדף התשלום
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={onCheckNow}>
                  בדיקת סטטוס עכשיו
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
