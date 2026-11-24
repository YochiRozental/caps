"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, EmptyState, Icon, Loading, SectionTitle, StatCard } from "@/components/ui";
import type { IconName } from "@/components/ui";
import { PaymentStatusBadge, SandboxNotice, SandboxPanel } from "@/components/payments/bits";
import {
  REFUND_REASON_TEXT,
  api,
  dateText,
  dateTimeText,
  durationText,
  shekel,
  usePaymentsGate,
  useSingleFlight,
} from "@/lib/payments/client";
import type { BalanceView, HistoryEntry, PackageView } from "@/lib/payments/views";
import { SecureCheckoutModal, type CheckoutPhase } from "@/components/payments/secure-checkout-modal";
import {
  canReopenCheckout,
  checkoutPhaseFor,
  isEmbeddableCheckoutUrl,
  parseStoredPurchase,
  pendingPackagePaymentIds,
  resolvePurchaseOutcome,
  type PurchaseResolution,
  type ReturnHint,
  type StoredPurchase,
} from "@/lib/payments/embedded-checkout";

export interface PackageOfferView {
  hours: number;
  priceAgorot: number;
  savingsAgorot: number;
}

type Tab = "balance" | "buy" | "history";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "balance", label: "היתרה שלי", icon: "clock" },
  { id: "buy", label: "רכישת חבילה", icon: "card" },
  { id: "history", label: "היסטוריה", icon: "list" },
];

export function HoursCenter({ canPurchase, packages }: { canPurchase: boolean; packages: PackageOfferView[] }) {
  const gate = usePaymentsGate();
  const [tab, setTab] = useState<Tab>("balance");
  const [balanceVersion, setBalanceVersion] = useState(0);
  const bump = useCallback(() => setBalanceVersion((v) => v + 1), []);
  const [recovered, setRecovered] = useState<string | null>(null);

  useEffect(() => {
    let tracked: StoredPurchase | null = null;
    try {
      tracked = parseStoredPurchase(window.sessionStorage.getItem(PURCHASE_STORAGE));
      if (tracked) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- הבחירה תלויה ברכישה שנשמרה בדפדפן לפני המעבר לתשלום
        setTab("buy");
      }
    } catch {
      // האחסון עשוי להיות חסום בדפדפן
    }
    // לקוח ששילם וסגר את הדפדפן לפני האישור: רכישות PENDING מההיסטוריה נשלחות לאימות בשרת. השרת לבדו מחליט,
    // והזיכוי חד-פעמי (HoursPackage.paymentId ייחודי), כך שבדיקה חוזרת לעולם לא מזכה פעמיים
    let cancelled = false;
    void (async () => {
      const history = await api<{ entries: HistoryEntry[] }>("/api/payments/history");
      if (!history.ok || cancelled) return;
      const ids = pendingPackagePaymentIds(history.data.entries ?? [], Date.now()).filter((id) => id !== tracked?.paymentId);
      let activatedHours = 0;
      for (const id of ids) {
        const res = await api<{ outcome?: string; package?: { hours: number } | null }>(`/api/payments/${id}`);
        if (res.ok && resolvePurchaseOutcome(res.data.outcome) === "activated") activatedHours += res.data.package?.hours ?? 0;
      }
      if (!cancelled && activatedHours > 0) {
        setRecovered(`תשלום שהושלם קודם אושר: ${durationText(activatedHours * 60)} נוספו ליתרה שלכם.`);
        bump();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bump]);

  return (
    <div className="space-y-6">
      {gate.sandbox && <SandboxNotice />}
      {recovered && <Alert tone="success">{recovered}</Alert>}
      <div role="tablist" aria-label="חבילות שעות" className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`btn btn-sm shrink-0 ${tab === t.id ? "btn-primary" : "btn-secondary"}`}
          >
            <Icon name={t.icon} className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "balance" && <BalanceTab key={balanceVersion} onBuy={() => setTab("buy")} />}
      {tab === "buy" && <BuyTab canPurchase={canPurchase} sandbox={gate.sandbox} onActivated={bump} packages={packages} />}
      {tab === "history" && <HistoryTab />}
    </div>
  );
}

// ───────────────────────────── יתרה ─────────────────────────────

const REQUEST_TEXT = {
  PENDING: { label: "בקשת ביטול ממתינה לבדיקת מנהל", cls: "bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200" },
  APPROVED: { label: "בקשת הביטול אושרה", cls: "bg-brand-50 text-brand-700 ring-1 ring-brand-100" },
  REJECTED: { label: "בקשת הביטול נדחתה", cls: "bg-red-50 text-red-700 ring-1 ring-red-100" },
} as const;

function BalanceTab({ onBuy }: { onBuy: () => void }) {
  const [view, setView] = useState<BalanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<PackageView | null>(null);

  const load = useCallback(async () => {
    const res = await api<BalanceView>("/api/payments/balance");
    if (res.ok) setView(res.data as BalanceView);
    else setError(res.data.error ?? "שגיאה בטעינת היתרה");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת היתרה מהשרת בעת פתיחת הלשונית
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!view) return <Loading />;

  const nothing = view.packages.length === 0 && view.credits.length === 0;

  return (
    <div className="space-y-6">
      {success && <Alert tone="success">{success}</Alert>}
      <StatCard label="סך היתרה הזמינה" value={durationText(view.totalMinutes)} icon="clock" tone="brand" />

      {nothing ? (
        <EmptyState icon="clock">
          אין לכם כרגע חבילה פעילה.
          <button type="button" onClick={onBuy} className="block mx-auto mt-3 btn btn-primary btn-sm">
            לרכישת חבילה
          </button>
        </EmptyState>
      ) : (
        <>
          {view.packages.length > 0 && (
            <section>
              <SectionTitle hint="ניצול לפי תוקף: החבילה שפוקעת ראשונה מנוצלת ראשונה">חבילות פעילות</SectionTitle>
              <ul className="grid gap-4 sm:grid-cols-2">
                {view.packages.map((p) => (
                  <PackageCard key={p.id} pkg={p} onCancel={() => setCancelFor(p)} />
                ))}
              </ul>
            </section>
          )}
          {view.credits.length > 0 && (
            <section>
              <SectionTitle hint="זיכויים מהחזרת דקות מחבילה שפג תוקפה. תקפים 30 יום, ומנוצלים לפני תשלום רגיל">זיכויים</SectionTitle>
              <ul className="grid gap-4 sm:grid-cols-2">
                {view.credits.map((c) => (
                  <li key={c.id} className="card p-5" data-testid="credit">
                    <p className="font-display text-lg font-bold text-stone-900">זיכוי {durationText(c.minutesRemaining)}</p>
                    <p className="text-sm text-stone-500 mt-1">
                      התקבל ב-{dateText(c.createdAt)} · בתוקף עד <strong>{dateText(c.expiresAt)}</strong>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {view.exhaustedPackages.length > 0 && (
        <details className="card p-5">
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">חבילות שנוצלו במלואן ({view.exhaustedPackages.length})</summary>
          <ul className="mt-3 space-y-2 text-sm text-stone-600">
            {view.exhaustedPackages.map((p) => (
              <li key={p.id}>
                חבילת {p.hours} שעות · נרכשה {dateText(p.purchasedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(view.expiredPackages.length > 0 || view.expiredCredits.length > 0) && (
        <details className="card p-5" data-testid="expired">
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">
            פג תוקפן, לא נכללות ביתרה הזמינה ({view.expiredPackages.length + view.expiredCredits.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-stone-600">
            {view.expiredPackages.map((p) => (
              <li key={p.id}>
                חבילת {p.hours} שעות · פגה ב-{dateText(p.expiresAt)} · נותרו {durationText(p.minutesRemaining)} שלא נוצלו
              </li>
            ))}
            {view.expiredCredits.map((c) => (
              <li key={c.id}>
                זיכוי {durationText(c.minutesTotal)} · פג ב-{dateText(c.expiresAt)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {cancelFor && (
        <CancelRequestDialog
          pkg={cancelFor}
          onClose={() => setCancelFor(null)}
          onSent={() => {
            setCancelFor(null);
            setSuccess("בקשת הביטול נשלחה וממתינה לבדיקת מנהל. החבילה נשארת פעילה עד להחלטה.");
            void load();
          }}
        />
      )}
    </div>
  );
}

function PackageCard({ pkg, onCancel }: { pkg: PackageView; onCancel: () => void }) {
  const req = pkg.cancellationRequest;
  // יחס לתצוגת פס בלבד: הערכים עצמם מגיעים מהשרת
  const pct = pkg.minutesTotal > 0 ? Math.round((pkg.minutesRemaining / pkg.minutesTotal) * 100) : 0;
  const canRequest = !req || req.status === "REJECTED";
  return (
    <li className="card p-5 space-y-3" data-testid="package">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold text-stone-900">חבילת {pkg.hours} שעות</p>
          <p className="text-xs text-stone-400 mt-0.5">שולם {shekel(pkg.pricePaidAgorot)}</p>
        </div>
        <p className="font-display text-2xl font-bold text-brand-700 tabular-nums text-left">{durationText(pkg.minutesRemaining)}</p>
      </div>
      <div className="h-2 rounded-full bg-cream-200 overflow-hidden" aria-hidden="true">
        <div className="h-full rounded-full bg-linear-to-l from-brand-500 to-bronze-400" style={{ width: `${pct}%` }} />
      </div>
      <dl className="text-sm text-stone-500 grid grid-cols-2 gap-y-1">
        <dt>נרכשה</dt>
        <dd className="text-stone-800 font-semibold tabular-nums">{dateText(pkg.purchasedAt)}</dd>
        <dt>בתוקף עד</dt>
        <dd className="text-stone-800 font-semibold tabular-nums">{dateText(pkg.expiresAt)}</dd>
        <dt>נותר מתוך</dt>
        <dd className="text-stone-800 font-semibold">{durationText(pkg.minutesTotal)}</dd>
      </dl>
      {req && <span className={`badge ${REQUEST_TEXT[req.status].cls}`}>{REQUEST_TEXT[req.status].label}</span>}
      {canRequest && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          בקשת ביטול חבילה
        </button>
      )}
    </li>
  );
}

function CancelRequestDialog({ pkg, onClose, onSent }: { pkg: PackageView; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  async function submit() {
    await run(async () => {
      setError(null);
      const res = await api(`/api/payments/packages/${pkg.id}/cancel-request`, { body: { reason } });
      if (res.ok) onSent();
      else setError(res.data.error ?? "לא ניתן לשלוח את הבקשה");
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-stone-900/40 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="cancel-dialog-title" className="card w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 id="cancel-dialog-title" className="font-display text-xl font-bold text-stone-900">
          בקשת ביטול חבילת {pkg.hours} שעות
        </h2>
        <p className="text-sm text-stone-600">
          הבקשה <strong>אינה מבטלת את החבילה ואינה מבצעת החזר אוטומטי</strong>. היא תיבדק על ידי מנהל בהתאם למדיניות ולדין, ועד להחלטה
          החבילה נשארת פעילה וניתנת לשימוש.
        </p>
        <div>
          <label htmlFor="cancel-reason" className="field-label">
            סיבת הביטול <span className="font-normal text-stone-400">(לא חובה)</span>
          </label>
          <textarea id="cancel-reason" className="field" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            חזרה
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "שולח..." : "שליחת בקשת ביטול"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── רכישת חבילות ─────────────────────────────

type PurchaseMessage = { tone: "success" | "error" | "warn"; text: string };

const PURCHASE_STORAGE = "hours:purchase";
const POLL_MS = 4000;

function newClientKey(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function savePurchase(p: StoredPurchase | null) {
  try {
    if (p) window.sessionStorage.setItem(PURCHASE_STORAGE, JSON.stringify(p));
    else window.sessionStorage.removeItem(PURCHASE_STORAGE);
  } catch {
    // האחסון עשוי להיות חסום בדפדפן: האימות בשרת ממשיך לעבוד, ורכישה שלא נסגרה תשוחזר מההיסטוריה
  }
}

const RESOLUTION_MESSAGE: Record<Exclude<PurchaseResolution, "activated" | "pending">, PurchaseMessage> = {
  failed: { tone: "error", text: "התשלום נכשל ולא בוצע חיוב. לא נוספה יתרה. אפשר לנסות שוב." },
  cancelled: { tone: "warn", text: "התשלום בוטל ולא בוצע חיוב. לא נוספה יתרה." },
  mismatch: { tone: "error", text: "סכום התשלום אינו תואם לחבילה ולכן היא לא הופעלה. אנא צרו קשר." },
};

interface Offer {
  hours: number;
  priceAgorot: number;
  key: string;
}

function BuyTab({ canPurchase, sandbox, onActivated, packages }: { canPurchase: boolean; sandbox: boolean; onActivated: () => void; packages: PackageOfferView[] }) {
  /** הכרטיסייה שנבחרה (חלונית התשלום פתוחה כשיש ערך) */
  const [offer, setOffer] = useState<Offer | null>(null);
  const [phase, setPhase] = useState<CheckoutPhase>("summary");
  const [returnHint, setReturnHint] = useState<ReturnHint>("unknown");
  const [purchase, setPurchase] = useState<StoredPurchase | null>(null);
  const [message, setMessage] = useState<PurchaseMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();
  const checking = useRef(false);

  const closeModal = useCallback(() => {
    setOffer(null);
    setPhase("summary");
    setReturnHint("unknown");
    setError(null);
  }, []);

  const verify = useCallback(
    async (p: StoredPurchase) => {
      if (checking.current) return;
      checking.current = true;
      try {
        const res = await api<{ outcome?: string; package?: { hours: number } | null }>(`/api/payments/${p.paymentId}`);
        if (!res.ok) {
          setMessage({ tone: "error", text: res.data.error ?? "לא ניתן לאמת את התשלום כעת" });
          return;
        }
        const resolution = resolvePurchaseOutcome(res.data.outcome);
        if (resolution === "pending") return;
        savePurchase(null);
        setPurchase(null);
        closeModal();
        if (resolution === "activated") {
          // הצלחה מוצגת רק אחרי שהשרת אישר שהחבילה הופעלה
          setMessage({ tone: "success", text: `התשלום אושר והחבילה הופעלה: ${durationText((res.data.package?.hours ?? p.hours) * 60)} נוספו ליתרה שלכם.` });
          onActivated();
        } else {
          setMessage(RESOLUTION_MESSAGE[resolution]);
        }
      } finally {
        checking.current = false;
      }
    },
    [onActivated, closeModal]
  );

  // המשך אחרי רענון דף: הרכישה הממתינה נשמרת בסשן, ומצבה נשאל מחדש מהשרת
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(PURCHASE_STORAGE);
    } catch {
      return;
    }
    const p = parseStoredPurchase(raw);
    if (!p) {
      if (raw) savePurchase(null);
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- שחזור רכישה ממתינה שנשמרה בסשן
    setPurchase(p);
    void verify(p);
  }, [verify]);

  // כל עוד יש רכישה פתוחה (גם כשהחלונית סגורה) השרת נשאל שוב ושוב. רק תשובתו קובעת הצלחה
  useEffect(() => {
    if (!purchase) return;
    const id = window.setInterval(() => void verify(purchase), POLL_MS);
    return () => window.clearInterval(id);
  }, [purchase, verify]);

  // שעון לתצוגה בלבד: מתי להפסיק להציע "חזרה לדף התשלום" (הקישור של Grow פג אחרי כ-10 דקות)
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!purchase) return;
    const tick = () => setClock(Date.now());
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [purchase]);

  async function start() {
    if (!offer) return;
    const { hours, key } = offer;
    await run(async () => {
      setError(null);
      setMessage(null);
      setPhase("creating");
      const res = await api<{
        paymentId: string;
        providerPaymentId?: string;
        hours: number;
        amountAgorot: number;
        checkoutUrl?: string;
        communicationTest?: boolean;
        outcome?: string;
        checkoutEmbeddable?: boolean;
      }>(
        "/api/payments/packages/purchase",
        // נשלחים רק מספר השעות ומפתח אידמפוטנטיות: המחיר נקבע בשרת. אותו מפתח בלחיצה חוזרת = אותה עסקה
        { body: { hours, clientKey: key } }
      );
      if (!res.ok) {
        setPhase("summary");
        setError(res.data.error ?? "לא ניתן ליצור את דף התשלום כעת. לא בוצע חיוב, אפשר לנסות שוב.");
        return;
      }
      // בדיקת תקשורת ל-Make (Staging בלבד): לא נוצר תשלום, אין מה לשמור או לאמת
      if (res.data.communicationTest) {
        closeModal();
        setMessage({ tone: "warn", text: `בדיקת תקשורת: הבקשה נשלחה ל-Make (${res.data.outcome ?? "לא ידוע"}). לא נוצר תשלום ולא נוספה יתרה.` });
        return;
      }
      const checkoutUrl = res.data.checkoutUrl;
      const embeddable = isEmbeddableCheckoutUrl(checkoutUrl);
      const p: StoredPurchase = {
        paymentId: res.data.paymentId,
        providerPaymentId: res.data.providerPaymentId,
        hours: res.data.hours,
        amountAgorot: res.data.amountAgorot,
        ...(embeddable ? { checkoutUrl, checkoutCreatedAt: Date.now() } : {}),
        ...(embeddable && res.data.checkoutEmbeddable === false ? { embeddable: false } : {}),
      };
      savePurchase(p);
      setPurchase(p);
      if (embeddable) {
        setPhase(checkoutPhaseFor(p.embeddable));
        return;
      }
      // ספק ללא דף תשלום (Mock מקומי): החלונית נסגרת והמצב מוצג בכרטיס הרכישה הממתינה
      closeModal();
      void verify(p);
    });
  }

  function openExternal() {
    if (!purchase?.checkoutUrl) return;
    // noopener: לדף התשלום אין גישה לחלון האתר. הסיום מזוהה מאימות השרת (polling), לא מהחלון החיצוני
    window.open(purchase.checkoutUrl, "_blank", "noopener,noreferrer");
    setReturnHint("unknown");
    setPhase("external");
  }

  function onReturned(hint: ReturnHint) {
    setReturnHint(hint);
    setPhase("verifying");
    if (purchase) void verify(purchase);
  }

  function reopen() {
    if (!purchase || !canReopenCheckout(purchase, Date.now())) return;
    setError(null);
    setReturnHint("unknown");
    setOffer({ hours: purchase.hours, priceAgorot: purchase.amountAgorot, key: "" });
    setPhase(checkoutPhaseFor(purchase.embeddable));
  }

  /** ביטול מעקב מקומי בלבד, אחרי שהשרת אישר שהתשלום עדיין לא הושלם. אם ישולם בהמשך - ישוחזר מההיסטוריה ויופעל */
  async function abandon() {
    if (!purchase) return;
    await run(async () => {
      const res = await api<{ outcome?: string }>(`/api/payments/${purchase.paymentId}`);
      if (res.ok && resolvePurchaseOutcome(res.data.outcome) === "pending") {
        savePurchase(null);
        setPurchase(null);
        setMessage({ tone: "warn", text: "הרכישה בוטלה ולא בוצע חיוב. אפשר לבחור כרטיסייה מחדש." });
      } else if (res.ok) {
        void verify(purchase);
      } else {
        setMessage({ tone: "error", text: res.data.error ?? "לא ניתן לבדוק את מצב התשלום כעת" });
      }
    });
  }

  const canReopen = !!purchase && clock > 0 && canReopenCheckout(purchase, clock);

  return (
    <div className="space-y-6">
      {!canPurchase && (
        <Alert tone="error">רכישת חבילות זמינה ללקוחות מאושרים בלבד. אחרי אישור החשבון תוכלו לרכוש חבילה.</Alert>
      )}
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`rounded-xl px-4 py-3 text-sm border ${
            message.tone === "success"
              ? "bg-brand-50 text-brand-700 border-brand-100"
              : message.tone === "error"
                ? "bg-red-50 text-red-700 border-red-100"
                : "bg-bronze-50 text-bronze-700 border-bronze-200"
          }`}
        >
          {message.text}
        </p>
      )}

      {purchase && !offer && (
        <section className="card p-5 sm:p-8 space-y-4" data-testid="purchase-status">
          <SectionTitle aside={<PaymentStatusBadge status="PENDING" />}>רכישת חבילת {purchase.hours} שעות</SectionTitle>
          <p className="text-sm text-stone-600">
            סכום לתשלום: <strong>{shekel(purchase.amountAgorot)}</strong>. ממתינים לאישור תשלום מאומת. אם כבר שילמתם, החבילה תופעל
            אוטומטית ברגע שהאישור יתקבל, ואין צורך לשלם שוב. ניתן לרענן את הדף בבטחה.
          </p>
          {sandbox && purchase.providerPaymentId && (
            <SandboxPanel providerPaymentId={purchase.providerPaymentId} onDone={() => void verify(purchase)} />
          )}
          <div className="flex flex-wrap gap-2">
            {canReopen && (
              <button type="button" className="btn btn-primary btn-sm" onClick={reopen}>
                <Icon name="lock" className="w-4 h-4" />
                חזרה לדף התשלום
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void verify(purchase)}>
              בדיקת סטטוס עכשיו
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void abandon()} disabled={busy}>
              ביטול הרכישה
            </button>
          </div>
        </section>
      )}

      <section>
        <SectionTitle hint="כל חבילה תקפה שנה מיום הרכישה, לכל החדרים, וניצולה לפי דקות">חבילות שעות</SectionTitle>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packages.map((p) => (
            <li key={p.hours} className="card card-hover p-5 flex flex-col gap-3" data-testid="package-offer">
              <p className="font-display text-3xl font-bold text-stone-900">{p.hours} שעות</p>
              <p className="font-display text-2xl font-bold text-brand-700 tabular-nums">{shekel(p.priceAgorot)}</p>
              <ul className="text-sm text-stone-500 space-y-1">
                <li>{shekel(Math.round(p.priceAgorot / p.hours))} לשעה</li>
                <li>חיסכון של {shekel(p.savingsAgorot)} לעומת מחיר רגיל</li>
                <li>תוקף: שנה מיום הרכישה</li>
              </ul>
              <button
                type="button"
                className="btn btn-primary mt-auto"
                disabled={!canPurchase || busy || !!purchase || !!offer}
                onClick={() => {
                  setError(null);
                  setMessage(null);
                  setPhase("summary");
                  setOffer({ hours: p.hours, priceAgorot: p.priceAgorot, key: newClientKey() });
                }}
              >
                רכישה
              </button>
            </li>
          ))}
        </ul>
      </section>

      {offer && (
        <SecureCheckoutModal
          hours={purchase?.hours ?? offer.hours}
          amountAgorot={purchase?.amountAgorot ?? offer.priceAgorot}
          phase={phase}
          checkoutUrl={purchase?.checkoutUrl}
          error={error}
          returnHint={returnHint}
          sandbox={sandbox}
          onStart={() => void start()}
          onClose={closeModal}
          onReturned={onReturned}
          onOpenExternal={openExternal}
          onReopen={canReopen ? reopen : undefined}
          onCheckNow={() => {
            if (purchase) void verify(purchase);
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────────── היסטוריה ─────────────────────────────

function HistoryTab() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: HistoryEntry[] }>("/api/payments/history").then((res) => {
      if (res.ok) setEntries(res.data.entries);
      else setError(res.data.error ?? "שגיאה בטעינת ההיסטוריה");
    });
  }, []);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!entries) return <Loading />;
  if (entries.length === 0) return <EmptyState icon="list">אין עדיין תשלומים או ניצולי דקות.</EmptyState>;

  return (
    <ul className="card divide-y divide-cream-100 overflow-hidden" data-testid="history">
      {entries.map((e) => (
        <HistoryRow key={e.id} e={e} />
      ))}
    </ul>
  );
}

function describe(e: HistoryEntry): { title: string; detail?: string; icon: IconName } {
  const where = e.roomName && e.startTime ? `${e.roomName} · ${dateTimeText(e.startTime)}` : undefined;
  switch (e.kind) {
    case "PACKAGE_PURCHASE":
      return { title: `רכישת חבילת ${e.hours ?? ""} שעות`, icon: "card" };
    case "BOOKING_PAYMENT":
      return {
        title: "תשלום על הזמנה",
        detail: [where, e.minutes ? `כולל ${durationText(e.minutes)} מהיתרה (יינוכו באישור)` : null].filter(Boolean).join(" · "),
        icon: "calendarCheck",
      };
    case "MINUTES_USED":
      return { title: `ניצול ${durationText(e.minutes ?? 0)} מהיתרה`, detail: where, icon: "clock" };
    case "MINUTES_RESTORED":
      return {
        title: e.convertedToCredit
          ? `החזרת ${durationText(e.minutes ?? 0)}: הומרו לזיכוי כי החבילה המקורית פגה`
          : `החזרת ${durationText(e.minutes ?? 0)} ליתרה`,
        detail: where,
        icon: "arrowUp",
      };
    case "CREDIT_GRANTED":
      return { title: `זיכוי ${durationText(e.minutes ?? 0)}`, detail: e.expiresAt ? `בתוקף עד ${dateText(e.expiresAt)}` : undefined, icon: "sparkle" };
    case "REFUND":
      return {
        title: "החזר כספי",
        detail: [where, e.reasonCode ? REFUND_REASON_TEXT[e.reasonCode] ?? null : null].filter(Boolean).join(" · "),
        icon: "arrowDown",
      };
  }
}

function HistoryRow({ e }: { e: HistoryEntry }) {
  const d = describe(e);
  return (
    <li className="px-4 sm:px-5 py-3.5 flex items-start gap-3 text-sm">
      <span className="w-9 h-9 rounded-full bg-bronze-50 text-bronze-600 ring-1 ring-bronze-100 flex items-center justify-center shrink-0">
        <Icon name={d.icon} className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-stone-800">{d.title}</p>
        {d.detail && <p className="text-stone-500 mt-0.5">{d.detail}</p>}
        <p className="text-xs text-stone-400 mt-0.5 tabular-nums">{dateTimeText(e.at)}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {e.amountAgorot !== undefined && (
          <span className={`font-semibold tabular-nums ${e.kind === "REFUND" ? "text-brand-700" : "text-stone-800"}`}>
            {e.kind === "REFUND" ? "+" : ""}
            {shekel(e.amountAgorot)}
          </span>
        )}
        {e.status && (e.kind === "PACKAGE_PURCHASE" || e.kind === "BOOKING_PAYMENT" || e.kind === "REFUND") && <PaymentStatusBadge status={e.status} />}
      </div>
    </li>
  );
}
