import type { Call } from "yemot-router2";
import type { RoomKey } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { BookingError, createBookingHold } from "@/lib/booking";
import { cancelBooking, quoteHold } from "@/lib/payments/booking-payment";
import { authorizeWithPin } from "@/lib/payments/authorization";
import { executeAuthorizedBooking, type AuthorizedBookingResult } from "@/lib/payments/authorized-actions";

import { getRuntimeProvider } from "@/lib/payments/runtime";
import { getHoldDetails } from "@/lib/payments/views";
import { ROOM_LABELS } from "@/lib/rooms";
import { text } from "@/ivr/messages";
import { spokenMinutes, spokenShekel, spokenWhen } from "@/ivr/spoken";

/**
 * הזמנה בתשלום בטלפון. פועלת רק מאחורי IVR_PAYMENTS_ENABLED ורק כשיש ספק תשלום תקף (ראו booking-flow). משתמשת אך ורק
 * בשירותי שלבים C+D+F.2: החזקה ל-10 דקות, אימות קוד טלפוני, הרשאה חד-פעמית, וביצוע דרך confirm-balance (ניכוי מיתרת שעות).
 * אין חיוב בכסף בטלפון: אין כרטיס שמור. הזמנה שהיתרה אינה מכסה במלואה מופנית לאתר, לתשלום בדף המאובטח של Grow.
 *
 * אבטחת הקוד: הקוד נקלט רק בבקשת POST שאין בה query בכלל (ראו secureTransport). בקשת GET או POST עם query אינה נקראת
 * כקוד: לא נבדק, לא נספר כניסיון, והשיחה מסתיימת. הקוד לא נרשם בלוג ולא נשמר במצב השיחה.
 *
 * ניקוי: כל יציאה לא מוצלחת (סירוב, ניתוק, timeout, שגיאה) משחררת את ההחזקה, חוץ ממצב שבו פעולה כספית בדרך.
 */

/** תקרת המתנה לקלט בשלבי התשלום. שיחה נטושה נקטעת (TimeoutError) ואז ההחזקה משוחררת, במקום להישאר תלויה */
const DEFAULT_STEP_TIMEOUT_MS = 90_000;
/** ניתן לדרוס רק במשתנה סביבה מספרי חיובי (לבדיקות); כל ערך אחר חוזר לברירת המחדל */
const stepTimeoutMs = () => {
  const override = Number(process.env.IVR_PAYMENT_STEP_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_STEP_TIMEOUT_MS;
};
const MAX_PIN_ENTRIES = 3;

/** הספרייה מכבדת timeout לכל read בנפרד בזמן ריצה, אך הטיפוס שלה מגדיר אותו רק כברירת מחדל כללית */
const withTimeout = <T extends object>(options: T): T => ({ ...options, timeout: stepTimeoutMs() }) as T;

const MSG = {
  noPin: "לא הוגדר לך קוד טלפוני ולכן לא ניתן להשלים הזמנה בתשלום בטלפון, היכנסו לאזור האישי באתר והגדירו קוד טלפוני, החדר שוחרר",
  noBalance: "אין לך יתרת שעות מספיקה להזמנה הזו, להזמנה בתשלום היכנסו לאתר, החדר שוחרר ולא בוצע חיוב",
  insecure: "אימות בקוד אינו זמין כרגע בערוץ הזה, לא בוצעה פעולה והחדר שוחרר",
  cancelled: "ההזמנה בוטלה והחדר שוחרר, תודה ולהתראות",
  expired: "הזמן להשלמת ההזמנה הסתיים והחדר שוחרר, לא בוצע חיוב, אפשר להתחיל מחדש",
  blocked: "בוצעו יותר מדי ניסיונות עם קוד שגוי, האימות נחסם זמנית, לא בוצעה פעולה והחדר שוחרר",
  unavailable: "האימות אינו זמין כרגע, נסו שוב מאוחר יותר, לא בוצעה פעולה והחדר שוחרר",
  tooManyEntries: "לא התקבל קוד תקין, לא בוצעה פעולה והחדר שוחרר",
  pinPrompt: "הקישו את הקוד הטלפוני בן ארבע ספרות",
  genericFailure: "אירעה שגיאה בשמירת החדר, נסו שוב מאוחר יותר",
};

/** ההקשה מגיעה רק אם הבקשה האחרונה הייתה POST בלי שום פרמטר ב-query (ערכים רגישים רק בגוף הבקשה) */
export function secureTransport(call: Call): boolean {
  const req = call.req;
  return req?.method === "POST" && Object.keys(req.query ?? {}).length === 0;
}

function resultMessage(result: AuthorizedBookingResult, ctx: { roomLabel: string; start: Date; durationMinutes: number }): { message: string; ok: boolean } {
  switch (result.status) {
    case "CONFIRMED":
      return {
        ok: true,
        message: `ההזמנה אושרה, ${ctx.roomLabel}, ${spokenWhen(ctx.start)}, למשך ${spokenMinutes(ctx.durationMinutes)}, נוצלו ${spokenMinutes(result.paidFromBalanceMinutes)} מהיתרה, תודה ולהתראות`,
      };
    case "AUTH_INVALID":
      return { ok: false, message: "האימות פג תוקף ולא בוצעה פעולה, אנא התחילו מחדש" };
    case "HOLD_EXPIRED":
      return { ok: false, message: MSG.expired };
    case "INSUFFICIENT_BALANCE":
      return { ok: false, message: "יתרת השעות השתנתה ואינה מספיקה, לא נוכו דקות ולא בוצע חיוב, אפשר להתחיל מחדש" };
    case "PLAN_CHANGED":
      return { ok: false, message: "יתרת השעות השתנתה, לא נוכו דקות ולא בוצע חיוב, אנא התחילו מחדש" };
    default:
      return { ok: false, message: "ההזמנה לא הושלמה, אנא פנו אלינו" };
  }
}

export async function runPaidBooking(
  call: Call,
  user: { id: string; name: string },
  details: { roomKey: RoomKey; startTime: Date; endTime: Date }
) {
  const provider = getRuntimeProvider();
  if (!provider) throw new Error("payment provider unavailable");

  const state = { holdId: undefined as string | undefined, executing: false, finished: false };

  const release = async () => {
    if (!state.holdId) return;
    try {
      // ביטול החזקה אידמפוטנטי; מבטל גם תשלום ממתין. בטוח לקרוא גם אם ההחזקה כבר פגה או שוחררה
      await cancelBooking({ appointmentId: state.holdId, requester: { id: user.id, role: "CLIENT" }, provider });
    } catch {
      console.error("[ivr] hold release failed");
    }
  };

  const end = async (message: string, opts: { release: boolean }) => {
    if (opts.release) await release();
    state.finished = true;
    return call.id_list_message([text(message)]);
  };

  const flow = async () => {
    // 1. החזקה ל-10 דקות (אידמפוטנטית: אותה הזמנה בקשה חוזרת מחזירה את אותה החזקה; תקרת 3 החזקות נאכפת בשירות)
    let hold;
    try {
      hold = await createBookingHold({ userId: user.id, ...details, source: "IVR" });
    } catch (err) {
      return end(err instanceof BookingError ? err.message : MSG.genericFailure, { release: false });
    }
    state.holdId = hold.id;

    // 2. זכאות: קוד טלפוני מוגדר, ערוץ בטוח, ויתרת שעות שמכסה את כל ההזמנה (אין חיוב בכסף בטלפון)
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { ivrPinHash: true } });
    if (!account?.ivrPinHash) return end(MSG.noPin, { release: true });
    if (!secureTransport(call)) return end(MSG.insecure, { release: true });

    const quote = await quoteHold({ appointmentId: hold.id, userId: user.id });
    if (!quote.fullyCoveredByBalance) return end(MSG.noBalance, { release: true });

    const price = quote.fullPriceAgorot;
    const sandbox = provider.environment === "sandbox" ? "סביבת בדיקות, " : "";
    const plan = `יתרת השעות מכסה את כל ההזמנה וינוצלו ${spokenMinutes(quote.packageMinutes)}`;

    // 3. הצגת מחיר ויתרה ובחירה
    const choice = await call.read(
      [text(`${sandbox}החדר שמור לך לעשר דקות, מחיר ההזמנה ${spokenShekel(price)}, ${plan}, לאישור הקישו 1, לביטול הקישו 2`)],
      "tap",
      withTimeout({ max_digits: 1, min_digits: 1, digits_allowed: [1, 2], sec_wait: 15 })
    );
    if (choice !== "1") return end(MSG.cancelled, { release: true });

    // 4. ההחזקה עדיין בתוקף? והערוץ בטוח לקליטת קוד? (לפני שמבקשים קוד)
    if (!(await getHoldDetails(hold.id, user.id)).holdActive) return end(MSG.expired, { release: true });
    if (!secureTransport(call)) return end(MSG.insecure, { release: true });

    // 5. אימות קוד: רק מגוף POST. כל ניסיון נספר בשירות (מסד), לא בשיחה
    let authorizationId: string | undefined;
    let prompt = MSG.pinPrompt;
    for (let entry = 0; entry < MAX_PIN_ENTRIES && !authorizationId; entry++) {
      const typed = await call.read([text(prompt)], "tap", withTimeout({ max_digits: 4, min_digits: 4, sec_wait: 15 }));
      // אם ההקשה הגיעה בכל ערוץ שאינו POST נקי: לא קוראים אותה בכלל
      if (!secureTransport(call)) return end(MSG.insecure, { release: true });

      const auth = await authorizeWithPin({
        userId: user.id,
        pin: typed,
        appointmentId: hold.id,
        action: "CONFIRM_BALANCE",
        amountAgorot: quote.cashAgorot,
        packageMinutes: quote.packageMinutes,
      });
      switch (auth.status) {
        case "OK":
          authorizationId = auth.authorizationId;
          break;
        case "INVALID":
          prompt = `הקוד שגוי, נותרו ${auth.attemptsLeft} ניסיונות, ${MSG.pinPrompt}`;
          break;
        case "INVALID_FORMAT":
          prompt = `הקוד אינו תקין, ${MSG.pinPrompt}`;
          break;
        case "BLOCKED":
          return end(MSG.blocked, { release: true });
        case "UNAVAILABLE":
          return end(MSG.unavailable, { release: true });
        case "NOT_SET":
          return end(MSG.noPin, { release: true });
        case "HOLD_INACTIVE":
          return end(MSG.expired, { release: true });
      }
    }
    if (!authorizationId) return end(MSG.tooManyEntries, { release: true });

    // 6. ביצוע הפעולה הכספית מכוח ההרשאה החד-פעמית. בזמן הביצוע לא משחררים החזקה בנפילה: תשלום עשוי להיות בדרך
    state.executing = true;
    const result = await executeAuthorizedBooking({ authorizationId, userId: user.id, appointmentId: hold.id, provider });
    state.executing = false;

    const { message, ok } = resultMessage(result, {
      roomLabel: ROOM_LABELS[details.roomKey],
      start: details.startTime,
      durationMinutes: quote.durationMinutes,
    });
    return end(message, { release: !ok });
  };

  try {
    return await flow();
  } catch (err) {
    // ניתוק, timeout או שגיאה לא צפויה: משחררים את ההחזקה, חוץ ממקרה של פעולה כספית שבדרך (היא תסתיים או תפוג לבדה)
    if (!state.finished && !state.executing) await release();
    throw err;
  }
}
