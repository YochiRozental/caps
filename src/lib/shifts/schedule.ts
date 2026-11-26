import type { PrismaClient, RoomKey } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { blockingAppointmentWhere, lockRoomZone } from "@/lib/booking";
import { jerusalemTodayIso } from "@/lib/jerusalem-time";
import { hoursRejection, resolveDay } from "@/lib/opening-hours";
import { loadWindows, trackForUser } from "@/lib/opening-hours-db";
import { isUniqueViolation } from "@/lib/payments/shared";
import { CONFLICTING_ROOM_KEYS, ROOM_KEYS } from "@/lib/rooms";
import { ensureRooms } from "@/lib/rooms-db";
import {
  parseIso,
  weekdayOf,
  billingDueDates,
  billingMonths,
  occurrenceDatesBetween,
  occurrencePriceAgorot,
  occurrenceTimes,
  periodKeyOf,
  shiftEndDate,
  validateStartDate,
  SHIFT_WEEKDAYS,
} from "@/lib/shifts/calendar";
import { requireActiveWindow } from "@/lib/shifts/windows-db";
import { windowPriceFor, type ShiftWindowDef } from "@/lib/shifts/windows";
import { abortPendingShift, grantMakeupCredits } from "@/lib/shifts/billing";
import { writeAudit } from "@/lib/finance/audit";

export { abortPendingShift };
import { ShiftError, type ShiftConflict } from "@/lib/shifts/errors";
import { MAX_OPEN_SHIFTS_PER_USER } from "@/lib/shifts/policy";

/**
 * תכנון ויצירה של משמרת קבועה. כל מופע הוא Appointment מאושר (source = SHIFT), ולכן מנגנון הזמינות וההתנגשויות הקיים
 * (blockingAppointmentWhere + נעילת ה-advisory של אזור החדר) חל עליו כמות שהוא: הזמנות רגילות, החזקות פעילות ומשמרות
 * אחרות חוסמות, והבדיקה והיצירה אטומיות תחת אותה נעילה. הבדיקה בממשק (preview) היא הצעה בלבד.
 */

export interface PlannedOccurrence {
  date: string;
  /** מפתח החיוב (YYYY-MM של מועד החיוב) של תקופת החיוב שבה חל המופע */
  month: string;
  startTime: Date;
  endTime: Date;
  priceAgorot: number;
  /** יום שנסגר במפורש ע"י ההנהלה: המופע מדולג והלקוח זכאי לשעה חלופית (אין החזר כספי) */
  skipReason?: string;
}

export interface ShiftPlan {
  occurrences: PlannedOccurrence[];
  conflicts: ShiftConflict[];
  startDate: string;
  endDate: string;
  /** המחיר החודשי של המשבצת (תמונת מצב ליצירה) */
  monthlyPriceAgorot: number;
  /** שלושת החיובים: מועד, סכום קבוע (בלי חישוב יחסי), וכמה מפגשים כלולים בתקופה */
  months: { month: string; dueDate: string; count: number; amountAgorot: number; isFirst: boolean }[];
  firstChargeAgorot: number;
  /** סך שלושת החיובים */
  totalAgorot: number;
}

export interface PlanInput {
  userId: string;
  roomKey: RoomKey;
  weekday: number;
  windowId: string;
  startDate: string;
  now?: Date;
  /** שינוי מאושר של משמרת קיימת רשאי להמשיך להשתמש במשבצת שהושבתה מאז (לא מזמינים אותה מחדש ללקוחות) */
  allowInactiveWindow?: boolean;
  /**
   * מחיר חודשי לתמחור המופעים, במקום מחיר המשבצת הנוכחי (ראו decideShiftRequest): שינוי מאושר שאינו כולל מעבר
   * מפורש למשבצת אחרת ממשיך לתמחר לפי המחיר שהלקוח כבר התחייב אליו, גם אם מחיר המשבצת עצמה נערך מאז.
   */
  priceOverrideAgorot?: number;
}

/** תכנון הלוח של משמרת חדשה: מאמת את הקלט, ומתכנן מתאריך ההתחלה ועד סוף שלושת החודשים. לא כולל זמינות החדר (ראו findRoomConflicts) */
export async function buildPlan(input: PlanInput, db: PrismaClient = defaultDb): Promise<ShiftPlan> {
  const { startDate, now = new Date() } = input;
  const startError = validateStartDate(startDate, jerusalemTodayIso(now));
  if (startError) throw new ShiftError(startError, "INVALID");
  const planned = await planOccurrences({ ...input, from: startDate, to: shiftEndDate(startDate), startDate }, db);
  return { ...summarize(planned.occurrences, startDate, planned.window, jerusalemTodayIso(now)), conflicts: planned.conflicts };
}

/**
 * ליבת התכנון, גם למשמרת קיימת בשינוי מאושר (מופעים חדשים מתאריך מסוים ועד סוף התקופה המקורית): תאריכים ביום השבוע,
 * שעות פעילות, מסלול המשתמש, ימים סגורים. ללא בדיקת זמינות החדר.
 */
export async function planOccurrences(
  input: Omit<PlanInput, "startDate"> & { from: string; to: string; /** תאריך ההתחלה המקורי של המשמרת (קובע את תקופות החיוב) */ startDate: string },
  db: PrismaClient = defaultDb
): Promise<{ occurrences: PlannedOccurrence[]; conflicts: ShiftConflict[]; window: ShiftWindowDef }> {
  const { userId, roomKey, weekday, windowId, from, to, startDate, allowInactiveWindow, priceOverrideAgorot } = input;

  if (!ROOM_KEYS.includes(roomKey)) throw new ShiftError("חדר לא קיים", "INVALID");
  if (!SHIFT_WEEKDAYS.includes(weekday as (typeof SHIFT_WEEKDAYS)[number])) throw new ShiftError("יום בשבוע לא תקין (אין משמרות בשבת)", "INVALID");

  await ensureRooms();
  const room = await db.room.findUnique({ where: { key: roomKey } });
  if (!room || !room.active) throw new ShiftError("החדר המבוקש אינו זמין", "INVALID");

  const track = await trackForUser(userId);
  if (!track) throw new ShiftError("יש להשלים מגדר בפרופיל כדי להזמין משמרת", "INVALID");

  const baseWindow = await requireActiveWindow(windowId, db, { allowInactive: allowInactiveWindow });
  // חדר סדנאות מתומחר במחיר חודשי נפרד; מכאן והלאה monthlyPriceAgorot של המשבצת הוא המחיר החל על החדר שנבחר
  const shiftWindow: ShiftWindowDef = { ...baseWindow, monthlyPriceAgorot: windowPriceFor(baseWindow, roomKey) };
  const windows = await loadWindows();
  const conflicts: ShiftConflict[] = [];
  const occurrences: PlannedOccurrence[] = occurrenceDatesBetween(from, to, weekday).map((date) => {
    const { startTime, endTime } = occurrenceTimes(date, shiftWindow);
    const occ: PlannedOccurrence = {
      date,
      month: periodKeyOf(startDate, date),
      startTime,
      endTime,
      priceAgorot: occurrencePriceAgorot(priceOverrideAgorot ?? shiftWindow.monthlyPriceAgorot, startDate, weekday, date),
    };
    const day = resolveDay(windows, date);
    if (day.closed) {
      // סגירה מפורשת של תאריך (חריג של מנהל): המופע מדולג והלקוח זכאי לשעה חלופית. יום שבועי סגור: אי אפשר לקבוע משמרת בו
      if (day.source === "exception") occ.skipReason = `יום סגור${day.note ? ` (${day.note})` : ""}`;
      else conflicts.push({ date, reason: "היום סגור לפי שעות הפעילות" });
      return occ;
    }
    const rejection = hoursRejection(windows, startTime, endTime, "SHIFT", track);
    if (rejection) conflicts.push({ date, reason: rejection });
    return occ;
  });

  if (occurrences.length === 0) throw new ShiftError("אין מופעים בתקופה שנבחרה", "INVALID");
  return { occurrences, conflicts, window: shiftWindow };
}

function summarize(occurrences: PlannedOccurrence[], startDate: string, window: ShiftWindowDef, todayIso: string) {
  const live = occurrences.filter((o) => !o.skipReason);
  // החיוב הראשון בעת אישור ההזמנה (היום), גם כשתאריך ההתחלה עתידי; השני והשלישי חודש וחודשיים אחרי תאריך ההתחלה
  const dueDates = [todayIso, ...billingDueDates(startDate).slice(1)];
  // שלושה חיובים בדיוק, כל אחד במחיר החודשי הקבוע (אין חישוב יחסי לחודש ראשון או אחרון)
  const months = billingMonths(startDate).map((month, index) => ({
    month,
    dueDate: dueDates[index],
    count: live.filter((o) => o.month === month).length,
    amountAgorot: window.monthlyPriceAgorot,
    isFirst: index === 0,
  }));
  return {
    occurrences,
    startDate,
    endDate: shiftEndDate(startDate),
    monthlyPriceAgorot: window.monthlyPriceAgorot,
    months,
    firstChargeAgorot: window.monthlyPriceAgorot,
    totalAgorot: window.monthlyPriceAgorot * months.length,
  };
}

type Db = Pick<PrismaClient, "appointment">;

/** התנגשויות עם הזמנות מאושרות / החזקות פעילות / משמרות אחרות בחדר (ובחדרים המתנגשים בו) */
export async function findRoomConflicts(db: Db, roomKey: RoomKey, occurrences: PlannedOccurrence[], now: Date): Promise<ShiftConflict[]> {
  const live = occurrences.filter((o) => !o.skipReason);
  if (live.length === 0) return [];
  const from = new Date(Math.min(...live.map((o) => o.startTime.getTime())));
  const to = new Date(Math.max(...live.map((o) => o.endTime.getTime())));
  const rows = await db.appointment.findMany({
    where: {
      ...blockingAppointmentWhere(now),
      room: { key: { in: CONFLICTING_ROOM_KEYS[roomKey] } },
      startTime: { lt: to },
      endTime: { gt: from },
    },
    select: { startTime: true, endTime: true },
  });
  return live
    .filter((o) => rows.some((r) => r.startTime < o.endTime && r.endTime > o.startTime))
    .map((o) => ({ date: o.date, reason: "החדר תפוס בשעות אלה" }));
}

/** הצעה לתצוגה מקדימה בלבד: תכנון + בדיקת זמינות, ללא נעילה וללא כתיבה */
export async function previewShift(input: PlanInput, db: PrismaClient = defaultDb): Promise<ShiftPlan> {
  const plan = await buildPlan(input, db);
  const roomConflicts = await findRoomConflicts(db, input.roomKey, plan.occurrences, input.now ?? new Date());
  return { ...plan, conflicts: [...plan.conflicts, ...roomConflicts] };
}

// ───────────────────────────── זכאות ─────────────────────────────

/** זכאות להזמנת משמרת, נבדקת בצד השרת מול המסד: אישור מפורש של מנהל, לקוח מאושר ולא חסום. חוב פתוח אינו חוסם */
export async function assertShiftEligible(userId: string, db: PrismaClient = defaultDb) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, canBookShifts: true, mustChangePassword: true },
  });
  if (!user || user.role !== "CLIENT") throw new ShiftError("רק לקוח רשאי להזמין משמרת", "FORBIDDEN");
  if (user.status === "BLOCKED") throw new ShiftError("החשבון חסום", "FORBIDDEN");
  if (user.status !== "APPROVED") throw new ShiftError("החשבון טרם אושר", "FORBIDDEN");
  if (!user.canBookShifts) throw new ShiftError("אין הרשאה להזמנת משמרות קבועות. ניתן לפנות להנהלה", "FORBIDDEN");
}

// ───────────────────────────── יצירה ─────────────────────────────

export type CreateShiftResult =
  | { status: "ACTIVE"; shiftId: string; firstChargeAgorot: number }
  /** משמרת ישנה (מלפני הסרת החיוב האוטומטי) שממתינה לתיעוד החיוב הראשון: מוחזרת רק בבקשה חוזרת עם אותו מפתח */
  | { status: "PENDING_REVIEW"; shiftId: string; firstChargeAgorot: number }
  | { status: "CHARGE_FAILED"; shiftId: string; failureCode?: string };

const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

function resultFor(shift: { id: string; status: string; occurrencePriceAgorot: number }, firstChargeAgorot: number, failureCode?: string): CreateShiftResult {
  if (shift.status === "ACTIVE") return { status: "ACTIVE", shiftId: shift.id, firstChargeAgorot };
  if (shift.status === "PENDING") return { status: "PENDING_REVIEW", shiftId: shift.id, firstChargeAgorot };
  return { status: "CHARGE_FAILED", shiftId: shift.id, failureCode };
}

/**
 * יוצר משמרת ע"י מנהל עבור לקוח זכאי: בדיקה ויצירה אטומית של כל המופעים תחת נעילת החדר, ושלוש שורות חיוב ממתינות.
 * אין כרטיס שמור ואין חיוב אוטומטי: כל משמרת מנוהלת בתשלום ידני, והמנהל מתעד כל תשלום שהתקבל (recordManualPayment).
 * המשמרת מאושרת מיד באישור המנהל. החיוב הראשון מועדו היום, השני והשלישי חודש וחודשיים אחרי תאריך ההתחלה.
 * אידמפוטנטי לפי clientKey (לחיצה כפולה/רענון מחזירים את אותה משמרת).
 */
/**
 * היום בשבוע של משמרת נגזר מתאריך ההתחלה, ולכן תאריך ההתחלה הוא תמיד מועד המפגש הראשון. יום שנשלח במפורש חייב להתאים
 * לתאריך (אחרת INVALID); שבת נדחית בבדיקת היום הקיימת (planOccurrences)
 */
export function shiftWeekdayForStart(startDate: string, requested?: number): number {
  if (!parseIso(startDate)) throw new ShiftError("תאריך התחלה לא תקין", "INVALID");
  const weekday = weekdayOf(startDate);
  if (requested !== undefined && requested !== weekday) throw new ShiftError("היום אינו תואם לתאריך ההתחלה", "INVALID");
  return weekday;
}

export async function createShift(
  params: Omit<PlanInput, "weekday"> & { weekday?: number; clientKey: string; createdById: string; db?: PrismaClient }
): Promise<CreateShiftResult> {
  const { userId, roomKey, windowId, startDate, clientKey, createdById, now = new Date(), db = defaultDb } = params;
  const weekday = shiftWeekdayForStart(startDate, params.weekday);

  await assertShiftEligible(userId, db);
  // משמרת נקבעת בתיאום עם מנהל בלבד: לקוח אינו רשאי ליצור אותה בעצמו (נבדק מול המסד, לא מול הבקשה)
  const actor = await db.user.findUnique({ where: { id: createdById }, select: { role: true } });
  if (actor?.role !== "ADMIN") throw new ShiftError("משמרת קבועה נקבעת על ידי מנהל בלבד", "FORBIDDEN");
  if (!CLIENT_KEY.test(clientKey)) throw new ShiftError("מפתח הבקשה אינו תקין", "INVALID");
  const idempotencyKey = `shift:${userId}:${clientKey}`;

  const replay = await db.shift.findUnique({ where: { idempotencyKey }, include: { charges: true } });
  if (replay) {
    const first = replay.charges.find((c) => c.isFirst);
    return resultFor(replay, first?.amountAgorot ?? 0, first?.failureCode ?? undefined);
  }

  const openShifts = await db.shift.count({ where: { userId, status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } } });
  if (openShifts >= MAX_OPEN_SHIFTS_PER_USER) throw new ShiftError("הגעת למספר המשמרות המרבי", "CONFLICT");

  const plan = await buildPlan({ userId, roomKey, weekday, windowId, startDate, now }, db);
  if (plan.conflicts.length > 0) throw new ShiftError("לא ניתן ליצור את המשמרת בגלל התנגשויות", "CONFLICT", { conflicts: plan.conflicts });

  const room = await db.room.findUniqueOrThrow({ where: { key: roomKey } });
  let shiftId: string;
  let replayed = false;
  try {
    shiftId = await db.$transaction(async (tx) => {
      // אותה נעילה בדיוק כמו createAppointment/החזקות: חדרים מתנגשים חולקים אזור, ולכן הבדיקה והיצירה מסודרות בטור
      await lockRoomZone(tx, roomKey);
      // בקשה מקבילה עם אותו מפתח (לחיצה כפולה) שהקדימה אותנו: זו אותה בקשה, לא התנגשות
      const earlier = await tx.shift.findUnique({ where: { idempotencyKey }, select: { id: true } });
      if (earlier) {
        replayed = true;
        return earlier.id;
      }
      const conflicts = await findRoomConflicts(tx, roomKey, plan.occurrences, now);
      if (conflicts.length > 0) throw new ShiftError("החדר תפוס באחד או יותר מהמופעים", "CONFLICT", { conflicts });

      const shift = await tx.shift.create({
        data: {
          userId,
          roomId: room.id,
          weekday,
          windowId,
          startDate,
          endDate: plan.endDate,
          status: "ACTIVE",
          occurrencePriceAgorot: Math.round(plan.monthlyPriceAgorot / 4),
          monthlyPriceAgorot: plan.monthlyPriceAgorot,
          idempotencyKey,
          createdById,
        },
      });
      // שלושת החיובים נוצרים מראש (ממתינים), כל אחד במועדו ובסכום הקבוע: כך אין חיוב רביעי ואין חישוב מחדש בדיעבד
      for (const m of plan.months) {
        await tx.shiftCharge.create({
          data: { shiftId: shift.id, month: m.month, dueDate: m.dueDate, amountAgorot: m.amountAgorot, occurrenceCount: m.count, isFirst: m.isFirst, status: "PENDING" },
        });
      }
      for (const occ of plan.occurrences) {
        if (occ.skipReason) {
          await tx.shiftOccurrence.create({
            data: {
              shiftId: shift.id,
              date: occ.date,
              month: occ.month,
              startTime: occ.startTime,
              endTime: occ.endTime,
              priceAgorot: occ.priceAgorot,
              status: "SKIPPED_CLOSED_DAY",
              statusNote: occ.skipReason,
              makeupStatus: "OWED",
            },
          });
          continue;
        }
        const appointment = await tx.appointment.create({
          data: { userId, roomId: room.id, startTime: occ.startTime, endTime: occ.endTime, status: "CONFIRMED", source: "SHIFT", notes: "משמרת קבועה" },
        });
        await tx.shiftOccurrence.create({
          data: { shiftId: shift.id, date: occ.date, month: occ.month, startTime: occ.startTime, endTime: occ.endTime, priceAgorot: occ.priceAgorot, appointmentId: appointment.id },
        });
      }
      return shift.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // בקשה מקבילה עם אותו מפתח הקדימה אותנו
      const raced = await db.shift.findUnique({ where: { idempotencyKey }, include: { charges: true } });
      if (raced) return resultFor(raced, raced.charges.find((c) => c.isFirst)?.amountAgorot ?? 0);
    }
    throw err;
  }

  if (replayed) {
    const existing = await db.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { charges: true } });
    return resultFor(existing, existing.charges.find((c) => c.isFirst)?.amountAgorot ?? 0, existing.charges.find((c) => c.isFirst)?.failureCode ?? undefined);
  }

  // המשמרת מאושרת באישור המנהל, והתשלומים מתועדים ידנית
  await writeAudit(db, { action: "shift.create_manual", adminId: createdById, userId, entityType: "Shift", entityId: shiftId, outcome: "ok", after: { monthlyPriceAgorot: plan.monthlyPriceAgorot, startDate, windowId, weekday } });
  await grantMakeupCredits(db, now, { shiftId });
  return { status: "ACTIVE", shiftId, firstChargeAgorot: plan.firstChargeAgorot };
}
