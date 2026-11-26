"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, EmptyState, Loading, SectionTitle } from "@/components/ui";
import { Dialog, ToneBadge, jerusalemTime } from "@/components/shifts/bits";
import { api, shekel, useSingleFlight } from "@/lib/payments/client";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import { todayIsoDate } from "@/lib/slots";
import { ShiftPriceTable } from "@/components/shifts/price-table";
import { windowLabelOf, type ShiftWindowDef } from "@/lib/shifts/windows";
import {
  CHARGE_STATUS_TEXT,
  REQUEST_KIND_TEXT,
  REQUEST_STATUS_TEXT,
  SHIFT_STATUS_TEXT,
  WEEKDAY_NAMES,
  dateLabel,
  failureText,
  minutesLabel,
  MAKEUP_STATE_TEXT,
  monthLabel,
  suspensionText,
  windowLabel,
} from "@/lib/shifts/labels";
import type { MyShiftsView, ShiftView } from "@/lib/shifts/views";

export function ShiftsCenter({ windows }: { windows: ShiftWindowDef[] }) {
  const [data, setData] = useState<MyShiftsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<MyShiftsView>("/api/shifts");
    if (res.ok) setData(res.data as MyShiftsView);
    else setError(res.data.error ?? "שגיאה בטעינת המשמרות");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת המשמרות מהשרת בעת פתיחת העמוד
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <Loading />;

  return (
    <div className="space-y-8">
      {notice && <Alert tone="success">{notice}</Alert>}

      <section className="space-y-4">
        <SectionTitle hint="שינוי או ביטול של משמרת מחייבים אישור מנהל">המשמרות שלי</SectionTitle>
        {data.shifts.length === 0 ? (
          <EmptyState icon="calendar">אין לכם משמרות קבועות.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {data.shifts.map((s) => (
              <ShiftCard key={s.id} shift={s} windows={windows} onChanged={load} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </section>

      <ShiftPriceTable windows={windows} />

      <section className="space-y-4">
        <SectionTitle hint="משמרת קבועה: אותו חדר, אותו יום ואותה משבצת, לשלושה חודשים קלנדריים לפחות">משמרת חדשה</SectionTitle>
        {!data.eligible ? (
          <p className="card p-5 text-sm text-stone-600" data-testid="not-eligible">
            משמרות קבועות זמינות ללקוחות שאושרו לכך על ידי ההנהלה. לבקשת אישור אפשר לפנות אלינו.
          </p>
        ) : (
          <p className="card p-5 text-sm text-stone-600" data-testid="new-shift-contact">
            משמרת קבועה נקבעת בתיאום עם ההנהלה. לקביעת משמרת חדשה פנו אלינו, ונשבץ אותה עבורכם. התשלום החודשי מתבצע
            בתיאום עם ההנהלה.
          </p>
        )}
      </section>
    </div>
  );
}

// ───────────────────────────── כרטיס משמרת ─────────────────────────────

function ShiftCard({ shift, windows, onChanged, onNotice }: { shift: ShiftView; windows: ShiftWindowDef[]; onChanged: () => void; onNotice: (m: string) => void }) {
  const [dialog, setDialog] = useState<"CHANGE" | "CANCEL" | null>(null);
  const st = SHIFT_STATUS_TEXT[shift.status] ?? { label: shift.status, tone: "neutral" as const };
  const canRequest = (shift.status === "ACTIVE" || shift.status === "SUSPENDED") && !shift.openRequest;
  const latest = shift.requests[0];

  return (
    <li className="card p-5 sm:p-6 space-y-4" data-testid="shift-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold text-stone-900">
            {shift.room.name} · יום {WEEKDAY_NAMES[shift.weekday]} · {windowLabel(shift.windowId)}
          </p>
          <p className="text-sm text-stone-500 mt-1">
            {dateLabel(shift.startDate)} עד {dateLabel(shift.endDate)} ·{" "}
            {shift.monthlyPriceAgorot > 0
              ? `${shekel(shift.monthlyPriceAgorot)} לחודש, ${shekel(shift.totalAgorot)} לשלושה חודשים (כולל מע"מ)`
              : `${shekel(shift.occurrencePriceAgorot)} למופע`}
          </p>
          <p className="text-xs text-stone-500 mt-1">תשלום בתיאום עם ההנהלה: אין חיוב אוטומטי, ההנהלה מתעדת כל תשלום שהתקבל.</p>
        </div>
        <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      </div>

      {shift.status === "SUSPENDED" && (
        <Alert tone="error">
          המשמרת מושעית: {suspensionText(shift.suspensionReason)}. המשבצות שלכם נשמרות, אך אין אפשרות להשתמש במשמרת עד החלטת מנהל.
        </Alert>
      )}
      {shift.status === "PENDING" && <p className="text-sm text-bronze-700">התשלום הראשון ממתין לאישור ההנהלה. המשבצות שמורות עד לאישור.</p>}
      {shift.makeups.length > 0 && (
        <div className="rounded-xl bg-cream-50 ring-1 ring-cream-200 px-4 py-3 text-sm space-y-2" data-testid="makeups">
          <p className="font-semibold text-stone-800">
            שעות חלופיות (הקליניקה נסגרה ביוזמת ההנהלה)
            {shift.makeupMinutesRemaining > 0 && <> · יתרה: <strong>{minutesLabel(shift.makeupMinutesRemaining)}</strong></>}
          </p>
          <ul className="space-y-1 text-stone-600">
            {shift.makeups.map((m) => (
              <li key={m.occurrenceId}>
                {dateLabel(m.date)}: מגיעות {minutesLabel(m.minutesTotal)}
                {m.state === "OPEN" && m.minutesRemaining < m.minutesTotal && <> · נותרו {minutesLabel(m.minutesRemaining)}</>}
                {m.expiresAt && m.state === "OPEN" && <> · בתוקף עד {dateLabel(m.expiresAt.slice(0, 10))}</>}
                {" "}<span className="text-xs text-stone-500">({MAKEUP_STATE_TEXT[m.state] ?? m.state})</span>
              </li>
            ))}
          </ul>
          {shift.makeupOwed > 0 && (
            <p className="text-stone-600">
              את השעות אפשר לממש בהזמנת חדר ב&quot;יתרת שעות&quot; (אישור מהיתרה), או בתיאום עם ההנהלה. אין שינוי בחיוב המשמרת.
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>מועד חיוב</th>
              <th>מפגשים בתקופה</th>
              <th>סכום חיוב</th>
              <th>מצב</th>
            </tr>
          </thead>
          <tbody>
            {shift.months.map((m) => {
              const cs = m.chargeStatus ? CHARGE_STATUS_TEXT[m.chargeStatus] : null;
              return (
                <tr key={m.month}>
                  <td className="tabular-nums">{m.dueDate ? dateLabel(m.dueDate) : monthLabel(m.month)}</td>
                  <td className="tabular-nums">{m.count}</td>
                  <td className="tabular-nums">{shekel(m.amountAgorot)}</td>
                  <td>
                    {cs ? (
                      <ToneBadge tone={cs.tone}>{m.manual ? "שולם (ידני)" : cs.label}</ToneBadge>
                    ) : (
                      <span className="text-stone-400 text-xs">ממתין לתשלום</span>
                    )}
                    {m.manual && <span className="block text-xs text-stone-500">התקבל ב-{dateLabel(m.manual.paidOn)}</span>}
                    {m.failureCode && m.chargeStatus === "FAILED" && <span className="block text-xs text-red-600 mt-1">{failureText(m.failureCode)}</span>}
                    {m.graceUntil && m.chargeStatus === "FAILED" && <span className="block text-xs text-stone-500">תקופת חסד עד {dateLabel(m.graceUntil.slice(0, 10))}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shift.nextCharge && (
        <p className="text-sm text-stone-600">
          החיוב הבא: <strong>{shekel(shift.nextCharge.amountAgorot)}</strong>
          {shift.nextCharge.dueDate ? ` ב-${dateLabel(shift.nextCharge.dueDate)}` : ` בתחילת ${monthLabel(shift.nextCharge.month)}`}.
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-stone-700">
          מופעים ({shift.counts.scheduled} מתוזמנים{shift.counts.skipped ? `, ${shift.counts.skipped} דולגו` : ""}{shift.counts.cancelled ? `, ${shift.counts.cancelled} בוטלו` : ""})
        </summary>
        {shift.upcoming.length > 0 ? (
          <ul className="mt-2 text-sm text-stone-600 space-y-1">
            {shift.upcoming.map((o) => (
              <li key={o.date} className="tabular-nums">
                {dateLabel(o.date)} · {jerusalemTime(o.startTime)}–{jerusalemTime(o.endTime)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-stone-500">אין מופעים עתידיים.</p>
        )}
      </details>

      {shift.charges.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">היסטוריית חיובים ({shift.charges.length})</summary>
          <ul className="mt-2 divide-y divide-cream-100 text-sm">
            {shift.charges.map((c) => {
              const cs = CHARGE_STATUS_TEXT[c.status] ?? { label: c.status, tone: "neutral" as const };
              return (
                <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {c.dueDate ? dateLabel(c.dueDate) : monthLabel(c.month)} · <strong className="tabular-nums">{shekel(c.amountAgorot)}</strong>
                    {c.refundedAgorot > 0 && <span className="text-brand-700"> (הוחזרו {shekel(c.refundedAgorot)})</span>}
                  </span>
                  <ToneBadge tone={cs.tone}>{cs.label}</ToneBadge>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {latest && (
        <p className="text-sm rounded-xl bg-cream-50 ring-1 ring-cream-200 px-4 py-3" data-testid="request-status">
          בקשת {REQUEST_KIND_TEXT[latest.kind]}:{" "}
          <ToneBadge tone={REQUEST_STATUS_TEXT[latest.status].tone}>{REQUEST_STATUS_TEXT[latest.status].label}</ToneBadge>
          {latest.status === "PENDING" && " המשמרת נשארת כפי שהיא עד שמנהל יחליט."}
          {latest.decisionNote && <span className="block mt-1 text-stone-500">הערת מנהל: {latest.decisionNote}</span>}
          {latest.status === "APPROVED" && latest.appliedFrom && <span className="block mt-1 text-stone-500">בתוקף מ-{dateLabel(latest.appliedFrom)}</span>}
        </p>
      )}

      {canRequest && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog("CHANGE")}>
            פנייה למנהל: שינוי
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog("CANCEL")}>
            פנייה למנהל: ביטול
          </button>
        </div>
      )}

      {dialog && (
        <RequestDialog
          shift={shift}
          windows={windows}
          kind={dialog}
          onClose={() => setDialog(null)}
          onSent={() => {
            setDialog(null);
            onNotice("הפנייה נשלחה וממתינה להחלטת מנהל. המשמרת נשארת ללא שינוי עד אז.");
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function RequestDialog({ shift, windows, kind, onClose, onSent }: { shift: ShiftView; windows: ShiftWindowDef[]; kind: "CHANGE" | "CANCEL"; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [roomKey, setRoomKey] = useState("");
  const [weekday, setWeekday] = useState("");
  const [windowId, setWindowId] = useState("");
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  async function submit() {
    await run(async () => {
      setError(null);
      const body = {
        kind,
        reason,
        requestedFrom: from || undefined,
        proposed:
          kind === "CHANGE"
            ? { roomKey: roomKey || undefined, weekday: weekday === "" ? undefined : Number(weekday), windowId: windowId || undefined }
            : undefined,
      };
      const res = await api(`/api/shifts/${shift.id}/requests`, { body });
      if (res.ok) onSent();
      else setError(res.data.error ?? "לא ניתן לשלוח את הבקשה");
    });
  }

  return (
    <Dialog title={kind === "CANCEL" ? "פנייה למנהל: ביטול משמרת" : "פנייה למנהל: שינוי משמרת"} labelId={`req-${shift.id}`} onClose={onClose}>
      <p className="text-sm text-stone-600">
        המשמרת היא התחייבות לשלושה חודשים, ולכן שינוי או ביטול אפשריים רק באישור מנהל. הפנייה <strong>אינה משנה דבר ואינה מבצעת החזר אוטומטי</strong>:
        היא תיבדק על ידי מנהל, ועד להחלטתו המשמרת והחיובים נשארים כפי שהם. היעדרות ממפגש אינה מזכה בהחזר או בזיכוי.
        {kind === "CHANGE" && " שינוי נכנס לתוקף רק מתקופת חיוב שטרם חויבה."}
      </p>
      {kind === "CHANGE" && (
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="field-label" htmlFor="rq-room">חדר</label>
            <select id="rq-room" className="field" value={roomKey} onChange={(e) => setRoomKey(e.target.value)}>
              <option value="">ללא שינוי</option>
              {ROOM_KEYS.map((k) => (
                <option key={k} value={k}>{ROOM_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="rq-day">יום</label>
            <select id="rq-day" className="field" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              <option value="">ללא שינוי</option>
              {WEEKDAY_NAMES.map((n, i) => (
                <option key={n} value={i}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="rq-win">משבצת</label>
            <select id="rq-win" className="field" value={windowId} onChange={(e) => setWindowId(e.target.value)}>
              <option value="">ללא שינוי</option>
              {windows.filter((w) => w.active).map((w) => (
                <option key={w.id} value={w.id}>{windowLabelOf(w)}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div>
        <label className="field-label" htmlFor="rq-from">
          החל מתאריך <span className="font-normal text-stone-400">(לא חובה)</span>
        </label>
        <input id="rq-from" type="date" className="field" value={from} min={todayIsoDate()} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div>
        <label className="field-label" htmlFor="rq-reason">
          סיבה <span className="font-normal text-stone-400">(לא חובה)</span>
        </label>
        <textarea id="rq-reason" className="field" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>חזרה</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? "שולח..." : "שליחת פנייה"}
        </button>
      </div>
    </Dialog>
  );
}

