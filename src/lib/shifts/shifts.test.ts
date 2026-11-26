import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";

// בדיקות משמרות קבועות מול PostgreSQL מקומי ייעודי: יצירה אטומית ע"י מנהל, זכאות, תמחור, שלושה חיובים חודשיים בתשלום ידני
// (אין כרטיס שמור ואין חיוב אוטומטי), ריצה יומית, איחור בתשלום, תקופת חסד, השעיה, סגירת יום, בקשות שינוי וביטול. רצות רק כש-SHIFTS_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי בשם *_test. דוגמה:
//   SHIFTS_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_shifts_test npm test
const testUrl = process.env.SHIFTS_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) throw new Error("SHIFTS_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
}

const SECRET = "shifts-test-secret-0123456789";
const SITE_PASSWORD = "Site-Pass-9xQ!";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// "היום" הקבוע של הבדיקות: יום שני 15.2.2027, שהוא גם תאריך ההתחלה (לכן מועד החיוב הראשון הוא היום). משמרת של יום שני:
// שלושה חיובים ב-15.2, 15.3 ו-15.4; סיום ב-14.5. 13 מפגשים: 4 בתקופה הראשונה (15.2–14.3), 5 בשנייה (15.3–14.4), 4 בשלישית (15.4–14.5)
const NOW = new Date("2027-02-15T09:00:00Z");
const START = "2027-02-15";

// מחיר חודשי קבוע של משבצת הבוקר: 480 ₪, והוא מה שמחויב בכל אחד משלושת החיובים (בלי חישוב יחסי).
// מחיר מופע (להחזר שמנהל אישר בלבד) = חודשי ÷ מפגשים בתקופה: 4 (120 ₪), 5 (96 ₪), 4 (120 ₪)
const MONTHLY = 48000;
const OCC_FEB = 12000;
const SESSIONS = 13;

describe("משמרות קבועות וחיוב חודשי: מול PostgreSQL מקומי", { skip: !testUrl && "SHIFTS_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let svc: typeof import("@/lib/shifts/schedule");
  let life: typeof import("@/lib/shifts/lifecycle");
  let bill: typeof import("@/lib/shifts/billing");
  let views: typeof import("@/lib/shifts/views");
  let gate: typeof import("@/lib/shifts/gate");
  let windowsDb: typeof import("@/lib/shifts/windows-db");
  let booking: typeof import("@/lib/booking");
  let payBooking: typeof import("@/lib/payments/booking-payment");
  let hoursDb: typeof import("@/lib/opening-hours-db");
  let pw: typeof import("@/lib/password");
  let MockPaymentProvider: typeof import("@/lib/payments/testing/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;
  let jerusalemParts: typeof import("@/lib/opening-hours").jerusalemParts;
  let provider: InstanceType<typeof MockPaymentProvider>;
  const ids: Record<string, string> = {};
  let keyCounter = 0;
  const key = () => `key-${Date.now()}-${keyCounter++}-abcdefgh`;

  async function wipe() {
    await prisma.refund.deleteMany({});
    await prisma.shiftChangeRequest.deleteMany({});
    await prisma.creditUsage.deleteMany({});
    await prisma.credit.deleteMany({});
    await prisma.packageUsage.deleteMany({});
    await prisma.hoursPackage.deleteMany({});
    await prisma.shiftCharge.deleteMany({});
    await prisma.shiftOccurrence.deleteMany({});
    await prisma.shift.deleteMany({});
    await prisma.cronRun.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.debtSettlement.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.appointment.deleteMany({});
    await prisma.mockProviderRecord.deleteMany({});
    await prisma.pinThrottle.deleteMany({});
    await prisma.openingWindow.deleteMany({});
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = (await import("@/lib/prisma")) as { prisma: PrismaClient });
    svc = await import("@/lib/shifts/schedule");
    life = await import("@/lib/shifts/lifecycle");
    bill = await import("@/lib/shifts/billing");
    views = await import("@/lib/shifts/views");
    gate = await import("@/lib/shifts/gate");
    windowsDb = await import("@/lib/shifts/windows-db");
    booking = await import("@/lib/booking");
    payBooking = await import("@/lib/payments/booking-payment");
    hoursDb = await import("@/lib/opening-hours-db");
    pw = await import("@/lib/password");
    ({ MockPaymentProvider } = await import("@/lib/payments/testing/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    ({ jerusalemParts } = await import("@/lib/opening-hours"));
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sh " } } });
  });

  /** מחזיר את ארבע המשבצות לערכי המחירון המקוריים (בדיקות העריכה משנות אותן) */
  async function resetWindows() {
    await prisma.shiftWindow.deleteMany({ where: { id: { notIn: ["MORNING", "NOON", "AFTERNOON", "EVENING"] } } });
    const defaults = [
      ["MORNING", "בוקר", 7, 11, 48000],
      ["NOON", "צהריים", 11, 15, 52500],
      ["AFTERNOON", "אחר הצהריים", 15, 19, 60000],
      ["EVENING", "ערב", 19, 22, 50000],
    ] as const;
    for (const [i, [id, name, from, to, price]] of defaults.entries()) {
      const data = { name, startMinutes: from * 60, endMinutes: to * 60, monthlyPriceAgorot: price, workshopMonthlyPriceAgorot: price * 2, active: true, sortOrder: i + 1 };
      await prisma.shiftWindow.upsert({ where: { id }, update: data, create: { id, ...data } });
    }
  }

  beforeEach(async () => {
    await resetWindows();
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sh " } } });
    provider = new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));
    const passwordHash = await pw.hashPassword(SITE_PASSWORD);
    const mk = async (k: string, extra: Record<string, unknown> = {}) => {
      ids[k] = (await prisma.user.create({ data: { name: `sh ${k}`, email: `sh-${k}@test.local`, passwordHash, gender: "MALE", status: "APPROVED", canBookShifts: true, ...(extra as object) } as never })).id;
    };
    await mk("a");
    await mk("b");
    await mk("noPerm", { canBookShifts: false });
    await mk("blocked", { status: "BLOCKED" });
    await mk("pending", { status: "PENDING" });
    await mk("female", { gender: "FEMALE" });
    await mk("admin", { role: "ADMIN", canBookShifts: false });
    await mk("c");
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sh " } } });
    await prisma.$disconnect();
  });

  // ───────────── עזרים ─────────────
  type Over = Partial<Parameters<typeof svc.createShift>[0]>;
  /** יצירה ע"י מנהל (הדרך היחידה ליצור משמרת): תשלום ידני, אין חיוב אוטומטי */
  const create = (userId: string, over: Over = {}) =>
    svc.createShift({ userId, roomKey: "ROOM3", weekday: 1, windowId: "MORNING", startDate: START, clientKey: key(), createdById: ids.admin, now: NOW, ...over });
  /** מנהל מתעד שהתשלום של תקופה התקבל (בסכום המדויק, בתאריך המועד) */
  async function pay(shiftId: string, month: string) {
    const charge = await chargeOf(shiftId, month);
    const paidOn = charge.dueDate!;
    await life.recordManualPayment({ chargeId: charge.id, adminId: ids.admin, amountAgorot: charge.amountAgorot, paidOn, confirm: true, now: new Date(`${paidOn}T10:00:00Z`) });
  }
  /** משמרת פעילה שהתשלום הראשון שלה תועד (המצב הרגיל אחרי קביעת משמרת) */
  async function createOk(userId = ids.a, over: Over = {}) {
    const res = await create(userId, over);
    assert.equal(res.status, "ACTIVE", JSON.stringify(res));
    const first = await prisma.shiftCharge.findFirstOrThrow({ where: { shiftId: res.shiftId, isFirst: true } });
    await pay(res.shiftId, first.month);
    return res.shiftId;
  }
  const cron = (now: Date, extra: Partial<Parameters<typeof bill.runMonthlyShiftBilling>[0]> = {}) =>
    bill.runMonthlyShiftBilling({ trigger: "test", now, ...extra });
  /** מועדי החיוב השני והשלישי (07:00 בשעון ירושלים) */
  const MARCH_15 = new Date("2027-03-15T05:00:00Z");
  const APRIL_15 = new Date("2027-04-15T05:00:00Z");
  const chargesOf = (shiftId: string) => prisma.shiftCharge.findMany({ where: { shiftId }, orderBy: { month: "asc" } });
  const chargeOf = (shiftId: string, month: string) => prisma.shiftCharge.findUniqueOrThrow({ where: { shiftId_month: { shiftId, month } } });
  /** תשלומים מול ספק עבור משמרות: תמיד 0 (אין חיוב אוטומטי) */
  const shiftPayments = () => prisma.payment.count({ where: { purpose: "SHIFT_MONTH" } });

  // ───────────── זכאות ─────────────

  test("זכאות נבדקת בשרת: בלי אישור מנהל, חסום או ממתין אי אפשר; מנהל מעניק ושולל; חוב פתוח אינו חוסם", async () => {
    for (const k of ["noPerm", "blocked", "pending"]) {
      await assert.rejects(() => create(ids[k]), { code: "FORBIDDEN" }, k);
    }
    await assert.rejects(() => create(ids.admin), { code: "FORBIDDEN" });
    assert.equal(await prisma.shift.count({}), 0);

    await assert.rejects(() => life.setShiftEligibility({ adminId: ids.a, userId: ids.noPerm, allowed: true }), { code: "FORBIDDEN" }, "לקוח אינו מעניק לעצמו");
    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.noPerm, allowed: true, now: NOW });
    const granted = await prisma.user.findUniqueOrThrow({ where: { id: ids.noPerm } });
    assert.deepEqual([granted.canBookShifts, granted.shiftEligibilityUpdatedById], [true, ids.admin]);
    await createOk(ids.noPerm);

    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.b, allowed: false });
    await assert.rejects(() => create(ids.b), { code: "FORBIDDEN" });
    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.b, allowed: true });

    // חוב פתוח אינו חוסם אוטומטית
    await prisma.debt.create({ data: { userId: ids.a, amountAgorot: 5200, createdById: ids.admin } });
    await createOk(ids.a, { roomKey: "ROOM4" });
  });

  test("רק מנהל יוצר משמרת: לקוח אינו יוצר משמרת בעצמו (גם לא בשם אחר); אין כרטיס שמור ואין חיוב אוטומטי", async () => {
    await assert.rejects(() => create(ids.a, { createdById: ids.a }), { code: "FORBIDDEN" }, "לקוח אינו יוצר משמרת לעצמו");
    await assert.rejects(() => create(ids.c, { createdById: ids.a }), { code: "FORBIDDEN" }, "וגם לא בשם לקוח אחר");
    assert.deepEqual([await prisma.shift.count({}), await prisma.appointment.count({})], [0, 0]);

    const res = await create(ids.c);
    assert.equal(res.status, "ACTIVE");
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: res.shiftId } });
    assert.deepEqual([shift.status, shift.createdById], ["ACTIVE", ids.admin]);
    assert.equal(await prisma.auditLog.count({ where: { action: "shift.create_manual", entityId: res.shiftId } }), 1);
    assert.deepEqual((await chargesOf(res.shiftId)).map((c) => c.status), ["PENDING", "PENDING", "PENDING"], "כל התשלומים ממתינים לתיעוד מנהל");
    assert.equal(await prisma.payment.count({}), 0, "אין תשלום מול ספק");
  });

  // ───────────── יצירה, תמחור ותקופה ─────────────

  test("חדר סדנאות: המשמרת מתומחרת בכפול מהמחיר הרגיל של המשבצת, וחדר רגיל באותה משבצת במחיר הרגיל", async () => {
    const regular = await create(ids.a, { windowId: "AFTERNOON", roomKey: "ROOM3" });
    const workshop = await create(ids.b, { windowId: "AFTERNOON", roomKey: "WORKSHOP" });
    assert.deepEqual([regular.status, workshop.status], ["ACTIVE", "ACTIVE"]);
    const rows = await prisma.shift.findMany({ where: { id: { in: [regular.shiftId, workshop.shiftId] } } });
    const monthly = (id: string) => rows.find((r) => r.id === id)!.monthlyPriceAgorot;
    assert.equal(monthly(regular.shiftId), 60000);
    assert.equal(monthly(workshop.shiftId), 120000);
    assert.equal(monthly(workshop.shiftId), 2 * monthly(regular.shiftId));
    const occ = await prisma.shiftOccurrence.findMany({ where: { shiftId: workshop.shiftId } });
    assert.ok(occ.every((o) => o.priceAgorot > 0));
    const regOcc = await prisma.shiftOccurrence.findMany({ where: { shiftId: regular.shiftId } });
    const sum = (rows: { priceAgorot: number }[]) => rows.reduce((n, o) => n + o.priceAgorot, 0);
    assert.ok(Math.abs(sum(occ) - 2 * sum(regOcc)) <= occ.length, "מחירי המופעים של סדנאות כפולים (עד עיגול לאגורה)");
  });

  test("יצירת משמרת לכל אחת מארבע המשבצות: מחיר חודשי קבוע, מפגשים כהזמנות מאושרות, ושלושה חיובים ממתינים לתשלום ידני", async () => {
    const expected: [string, string, number][] = [
      ["MORNING", "ROOM3", 48000],
      ["NOON", "ROOM4", 52500],
      ["AFTERNOON", "WORKSHOP", 120000], // חדר סדנאות: כפול מהמחיר הרגיל של המשבצת (60000)
      ["EVENING", "ROOM2", 50000],
    ];
    for (const [windowId, roomKey, monthly] of expected) {
      const res = await create(ids.a, { windowId, roomKey: roomKey as never });
      assert.deepEqual([res.status, res.status === "ACTIVE" && res.firstChargeAgorot], ["ACTIVE", monthly], windowId);
      const shift = await prisma.shift.findUniqueOrThrow({ where: { id: res.shiftId }, include: { occurrences: true, charges: { orderBy: { month: "asc" } } } });
      assert.equal(shift.status, "ACTIVE");
      assert.equal(shift.endDate, "2027-05-14", "שלושה חודשים מתאריך ההתחלה");
      assert.equal(shift.monthlyPriceAgorot, monthly);
      assert.equal(shift.occurrences.length, SESSIONS, `${windowId}: 13 ימי שני בין 15.2 ל-14.5`);
      assert.ok(shift.occurrences.every((o) => o.status === "SCHEDULED" && o.appointmentId));
      // שלושה חיובים בדיוק, כל אחד בסכום הקבוע, במועדים שנגזרים מתאריך ההתחלה. אף אחד אינו נגבה אוטומטית
      assert.deepEqual(shift.charges.map((c) => [c.month, c.dueDate, c.amountAgorot, c.status]), [
        ["2027-02", "2027-02-15", monthly, "PENDING"],
        ["2027-03", "2027-03-15", monthly, "PENDING"],
        ["2027-04", "2027-04-15", monthly, "PENDING"],
      ]);
      assert.deepEqual([shift.charges[0].isFirst, shift.charges[0].occurrenceCount], [true, 4]);
    }
    const appts = await prisma.appointment.findMany({ where: { source: "SHIFT" } });
    assert.equal(appts.length, 4 * SESSIONS);
    assert.ok(appts.every((a) => a.status === "CONFIRMED" && a.userId === ids.a));
    assert.equal(await prisma.payment.count({}), 0, "אין חיוב אוטומטי: אין תשלום מול ספק");
  });

  test("שעות המופעים בשעון ירושלים, כולל מעבר לשעון קיץ (26.3.2027) באמצע התקופה", async () => {
    const shiftId = await createOk(ids.a, { windowId: "NOON" });
    const occ = await prisma.shiftOccurrence.findMany({ where: { shiftId }, orderBy: { date: "asc" } });
    assert.ok(occ.some((o) => o.date < "2027-03-26") && occ.some((o) => o.date > "2027-03-26"));
    for (const o of occ) {
      assert.deepEqual([jerusalemParts(o.startTime).date, jerusalemParts(o.startTime).minutes, jerusalemParts(o.endTime).minutes], [o.date, 11 * 60, 15 * 60], o.date);
    }
  });

  test("אין חישוב יחסי: חיוב ראשון מלא גם כשהמפגש הראשון רחוק מתאריך ההתחלה; התחלה עתידית: מועד החיוב הראשון בעת האישור, והשני והשלישי לפי תאריך ההתחלה", async () => {
    // התחלה ביום רביעי 17.2: המפגש הראשון ב-22.2. החיוב הראשון מלא (480 ₪), לא יחסי
    const mid = await createOk(ids.a, { startDate: "2027-02-17" });
    const ch = await chargeOf(mid, "2027-02");
    assert.deepEqual([ch.amountAgorot, ch.status, ch.dueDate], [MONTHLY, "PAID", "2027-02-15"], "מועדו בעת האישור (15.2)");

    // התחלה עתידית (26.2): מועד החיוב הראשון הוא יום האישור, השני והשלישי חודש וחודשיים אחרי תאריך ההתחלה
    const future = await create(ids.b, { startDate: "2027-02-26", roomKey: "ROOM4" });
    assert.equal(future.status, "ACTIVE");
    assert.deepEqual((await chargesOf(future.shiftId)).map((c) => [c.month, c.dueDate, c.status]), [["2027-02", "2027-02-15", "PENDING"], ["2027-03", "2027-03-26", "PENDING"], ["2027-04", "2027-04-26", "PENDING"]]);
    const first = await chargeOf(future.shiftId, "2027-02");
    assert.deepEqual([first.isFirst, first.amountAgorot], [true, MONTHLY]);

    // הריצה היומית לעולם אינה מחייבת: היא רק מסמנת תשלום שלא התקבל במועד. השני אינו "באיחור" לפני מועדו
    await pay(future.shiftId, "2027-02");
    await cron(new Date("2027-03-25T05:00:00Z"));
    assert.equal((await chargeOf(future.shiftId, "2027-03")).status, "PENDING");
    await cron(new Date("2027-03-27T05:00:00Z"));
    assert.equal((await chargeOf(future.shiftId, "2027-03")).failureCode, "manual_payment_overdue", "יום אחרי המועד, בלי תשלום מתועד");
    assert.equal(await shiftPayments(), 0, "אין שום חיוב מול ספק");
  });

  test("תאריכי חיוב חריגים: התחלה ב-31.1 -> 28.2 -> 31.3 (כל מועד ביחס לתאריך המקורי), ובדיוק שלושה חיובים", async () => {
    const JAN31 = new Date("2027-01-31T09:00:00Z");
    // יום ראשון (מסלול בנות): לקוחה
    const id = await createOk(ids.female, { weekday: 0, startDate: "2027-01-31", now: JAN31, roomKey: "ROOM1" });
    const charges = await chargesOf(id);
    assert.deepEqual(charges.map((c) => [c.month, c.dueDate]), [["2027-01", "2027-01-31"], ["2027-02", "2027-02-28"], ["2027-03", "2027-03-31"]]);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id } })).endDate, "2027-04-29", "31.1 + 3 חודשים = 30.4, והסיום יום לפני");
    await cron(new Date("2027-02-28T05:00:00Z"));
    assert.equal((await chargeOf(id, "2027-02")).status, "PENDING", "ביום המועד עוד אין איחור");
    await pay(id, "2027-02");
    await pay(id, "2027-03");
    // אחרי סוף התקופה: אין חיוב רביעי, והמשמרת מסתיימת
    await cron(new Date("2027-05-01T05:00:00Z"));
    await cron(new Date("2027-06-01T05:00:00Z"));
    assert.equal((await chargesOf(id)).length, 3);
    assert.deepEqual((await chargesOf(id)).map((c) => c.status), ["PAID", "PAID", "PAID"]);
    assert.equal(await shiftPayments(), 0);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id } })).status, "ENDED");
  });

  test("מעבר שנה: תקופה דצמבר-מרץ, חיובים ב-14.12, 14.1 ו-14.2, והמפגשים בתקופת החיוב הנכונה", async () => {
    const NOW2 = new Date("2026-12-10T09:00:00Z");
    const shiftId = await createOk(ids.a, { now: NOW2, startDate: "2026-12-14" });
    const occ = await prisma.shiftOccurrence.findMany({ where: { shiftId }, orderBy: { date: "asc" } });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).endDate, "2027-03-13");
    const byPeriod = occ.reduce<Record<string, number>>((m, o) => ({ ...m, [o.month]: (m[o.month] ?? 0) + 1 }), {});
    assert.deepEqual(byPeriod, { "2026-12": 5, "2027-01": 4, "2027-02": 4 });
    assert.deepEqual((await chargesOf(shiftId)).map((c) => [c.month, c.dueDate, c.amountAgorot]), [["2026-12", "2026-12-10", MONTHLY], ["2027-01", "2027-01-14", MONTHLY], ["2027-02", "2027-02-14", MONTHLY]]);
    assert.equal((await chargeOf(shiftId, "2026-12")).status, "PAID", "מועד הראשון בעת האישור (10.12), לפני תאריך ההתחלה");
    await pay(shiftId, "2027-01");
    await pay(shiftId, "2027-02");
    await cron(new Date("2027-02-14T05:00:00Z"));
    assert.deepEqual((await chargesOf(shiftId)).map((c) => c.status), ["PAID", "PAID", "PAID"]);
    assert.equal(await shiftPayments(), 0);
  });

  test("תאריך התחלה בעבר או רחוק מדי, ויום/משבצת לא תקינים נדחים", async () => {
    for (const startDate of ["2027-02-09", "2027-03-20", "not-a-date"]) await assert.rejects(() => create(ids.a, { startDate }), { code: "INVALID" }, startDate);
    await assert.rejects(() => create(ids.a, { weekday: 6 }), { code: "INVALID" });
    await assert.rejects(() => create(ids.a, { windowId: "MIDNIGHT" }), { code: "INVALID" });
    await assert.rejects(() => create(ids.a, { clientKey: "short" }), { code: "INVALID" });
    assert.equal(await prisma.shift.count({}), 0);
  });

  test("שעות הפעילות והמסלול נאכפים: שישי נסגר ב-12:00 (צהריים נדחה, בוקר מתקבל); לקוחה במסלול בנות לא מזמינה יום בנים; ערב 19–22 בתוך הפעילות", async () => {
    // שישי: 07:00–12:00 בלבד. משבצת צהריים (11–15) חורגת בכל 13 השישיים, בוקר (7–11) מתקבלת
    await assert.rejects(() => create(ids.a, { weekday: 5, windowId: "NOON" }), (e: { code: string; details?: { conflicts: unknown[] } }) => e.code === "CONFLICT" && (e.details?.conflicts.length ?? 0) === SESSIONS);
    await createOk(ids.a, { weekday: 5, windowId: "MORNING" });
    // ערב 19:00–22:00 בתוך שעות הפעילות (א'–ה' עד 24:00)
    await createOk(ids.a, { windowId: "EVENING", roomKey: "ROOM2" });
    await assert.rejects(() => create(ids.female), { code: "CONFLICT" }, "יום שני הוא מסלול בנים");
    await createOk(ids.female, { weekday: 2 }); // יום שלישי: מסלול בנות
    assert.equal(await prisma.shift.count({}), 3);
  });

  // ───────────── ימים סגורים ושעות פעילות ─────────────

  test("יום שנסגר במפורש לפני היצירה: המפגש מדולג והלקוח זכאי לשעה חלופית; החיוב נשאר מלא; שינוי רגיל בשעות אינו מבטל משמרת קיימת", async () => {
    await hoursDb.replaceDate("2027-03-08", { closed: true, note: "חג" });
    const shiftId = await createOk();
    const skipped = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId, date: "2027-03-08" } } });
    assert.deepEqual([skipped.status, skipped.appointmentId, skipped.makeupStatus], ["SKIPPED_CLOSED_DAY", null, "OWED"]);
    await pay(shiftId, "2027-03");
    const march = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([march.amountAgorot, march.status], [MONTHLY, "PAID"], "הסגירה אינה מפחיתה את החיוב: מחיר חודשי קבוע");

    // שינוי רגיל בשעות (יום שני 09:00–10:00) אינו נוגע במשמרת
    await hoursDb.replaceWeekday(1, [{ startMinutes: 9 * 60, endMinutes: 10 * 60, activity: "BOYS" }], "BOYS", false);
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), SESSIONS - 1);
    assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), SESSIONS - 1);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");
  });

  test("סגירת יום ביוזמת ההנהלה אחרי שהתקופה שולמה: דילוג, הזמנה מבוטלת, החדר מתפנה, שעה חלופית, ובלי החזר או שינוי חיוב", async () => {
    const shiftId = await createOk();
    await pay(shiftId, "2027-03");
    const paid = await chargeOf(shiftId, "2027-03");
    assert.equal(paid.status, "PAID");

    await assert.rejects(() => life.applyDayClosure({ date: "2027-03-22", adminId: ids.a }), { code: "FORBIDDEN" });
    const first = await life.applyDayClosure({ date: "2027-03-22", adminId: ids.admin, now: new Date("2027-03-22T09:00:00Z") });
    assert.deepEqual([first.skipped, first.makeupOwed], [1, 1]);
    const occ = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId, date: "2027-03-22" } } });
    assert.deepEqual([occ.status, occ.refundedAgorot, occ.makeupStatus], ["SKIPPED_CLOSED_DAY", 0, "OWED"]);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: occ.appointmentId! } })).status, "CANCELLED");
    const after = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([after.amountAgorot, after.refundedAgorot, after.status], [MONTHLY, 0, "PAID"]);
    assert.equal(await prisma.refund.count({}), 0, "אין החזר כספי: הלקוח זכאי לשעה חלופית");

    const again = await life.applyDayClosure({ date: "2027-03-22", adminId: ids.admin });
    assert.deepEqual([again.skipped, again.makeupOwed], [0, 1], "הרצה חוזרת אינה יוצרת זכאות כפולה");
    // החדר פנוי להזמנה רגילה באותה שעה
    const start = occ.startTime;
    const walkIn = await booking.createAppointment({ userId: ids.b, roomKey: "ROOM3", startTime: start, endTime: new Date(start.getTime() + HOUR), source: "ADMIN" });
    assert.equal(walkIn.status, "CONFIRMED");
    // ההיסטוריה נשמרה (המפגש והחיוב לא נמחקו)
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId } }), SESSIONS);

    // הזיכוי: בדיוק משך המפגש שבוטל (בוקר 07:00–11:00 = 240 דקות) נרשם ביתרות הלקוח, פעם אחת בלבד
    const withCredit = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { id: occ.id } });
    const credit = await prisma.credit.findUniqueOrThrow({ where: { id: withCredit.makeupCreditId! } });
    assert.deepEqual([credit.userId, credit.minutesTotal, credit.minutesRemaining, credit.reason], [ids.a, 240, 240, `shift_makeup:${occ.id}`]);
    assert.equal(await prisma.credit.count({ where: { userId: ids.a } }), 1, "הרצה חוזרת לא יצרה זיכוי נוסף");
    const view = (await views.getMyShifts({ userId: ids.a, now: new Date("2027-03-23T09:00:00Z") })).shifts[0];
    assert.deepEqual(view.makeups.map((m) => [m.date, m.state, m.minutesTotal, m.minutesRemaining]), [["2027-03-22", "OPEN", 240, 240]]);
    assert.deepEqual([view.makeupOwed, view.makeupMinutesRemaining], [1, 240]);
    const regularOcc = await prisma.shiftOccurrence.findFirstOrThrow({ where: { shiftId, status: "SCHEDULED" } });
    await assert.rejects(() => life.waiveOccurrenceMakeup({ occurrenceId: regularOcc.id, adminId: ids.admin }), { code: "NOT_FOUND" }, "אין זכאות במפגש רגיל");
    assert.equal((await chargesOf(shiftId)).map((c) => c.amountAgorot).join(), [MONTHLY, MONTHLY, MONTHLY].join(), "שלושת החיובים לא השתנו");
  });

  test("סגירת יום לפני שהתקופה שולמה, וגם אחרי שהתשלום לא התקבל במועד: החיוב נשאר הסכום המלא הקבוע", async () => {
    const shiftId = await createOk();
    const summary = await life.applyDayClosure({ date: "2027-04-12", adminId: ids.admin });
    assert.deepEqual([summary.skipped, summary.makeupOwed], [1, 1]);
    await pay(shiftId, "2027-03");
    const march = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([march.amountAgorot, march.status], [MONTHLY, "PAID"], "12.4 שייך לתקופה השנייה: החיוב עדיין מלא");
    assert.equal(march.occurrenceCount, 4, "מספר המפגשים בתקופה ירד (מידע בלבד)");

    // תשלום שלא התקבל במועד ואז יום נסגר: אין הפחתה ואין החזר
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    await cron(new Date(MARCH_15.getTime() + DAY));
    assert.equal((await chargeOf(b, "2027-03")).status, "FAILED");
    const closure = await life.applyDayClosure({ date: "2027-03-22", adminId: ids.admin });
    assert.equal(closure.skipped, 2, "שתי המשמרות מופיעות ב-22.3");
    const unchanged = await chargeOf(b, "2027-03");
    assert.deepEqual([unchanged.amountAgorot, unchanged.status], [MONTHLY, "FAILED"]);
    assert.equal(await prisma.refund.count({}), 0);
  });

  // ───────────── התנגשויות ומקביליות ─────────────

  test("התנגשות עם הזמנה רגילה, החזקה פעילה, משמרת אחרת וחדר משולב: נדחה, ולא נוצר דבר", async () => {
    const monday = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00+02:00`);
    // הזמנה רגילה במרץ
    await booking.createAppointment({ userId: ids.b, roomKey: "ROOM3", startTime: monday("2027-03-08", 9), endTime: monday("2027-03-08", 10), source: "ADMIN" });
    await assert.rejects(() => create(ids.a), (e: { code: string; details?: { conflicts: { date: string }[] } }) => e.code === "CONFLICT" && e.details!.conflicts.some((c) => c.date === "2027-03-08"));
    assert.deepEqual([await prisma.shift.count({}), await prisma.appointment.count({ where: { source: "SHIFT" } }), await prisma.payment.count({})], [0, 0, 0]);

    // החזקה פעילה (בשעון הבדיקה) חוסמת; החזקה שפגה אינה חוסמת
    await booking.createBookingHold({ userId: ids.b, roomKey: "ROOM4", startTime: monday("2027-03-22", 13), endTime: monday("2027-03-22", 14), source: "WEB", now: NOW });
    await assert.rejects(() => create(ids.a, { roomKey: "ROOM4", windowId: "NOON" }), { code: "CONFLICT" });
    await prisma.appointment.updateMany({ where: { status: "PENDING_PAYMENT" }, data: { holdExpiresAt: new Date(NOW.getTime() - 1000) } });
    await createOk(ids.a, { roomKey: "ROOM4", windowId: "NOON" });

    // משמרת אחרת באותו חדר/יום/משבצת, וחדר משולב שמתנגש בחדר 1
    await assert.rejects(() => create(ids.b, { roomKey: "ROOM4", windowId: "NOON" }), { code: "CONFLICT" });
    await createOk(ids.b, { roomKey: "ROOM1" });
    await assert.rejects(() => create(ids.a, { roomKey: "ROOM1_2" }), { code: "CONFLICT" });
  });

  test("שתי בקשות יצירה מקבילות לאותו חדר, יום ומשבצת: משמרת אחת בלבד, ללא חפיפה", async () => {
    for (let round = 0; round < 3; round++) {
      await wipe();
      const results = await Promise.allSettled([create(ids.a), create(ids.b)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `סבב ${round}`);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(rejected[0].reason.code, "CONFLICT");
      assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), SESSIONS);
      assert.equal(await prisma.shift.count({ where: { status: "ACTIVE" } }), 1);
    }
  });

  test("שתי משמרות מקבילות בחדרים שונים מצליחות; ולחיצה כפולה (אותו מפתח) מחזירה את אותה משמרת בלי משמרת או חיובים כפולים", async () => {
    const [x, y] = await Promise.all([create(ids.a, { roomKey: "ROOM3" }), create(ids.b, { roomKey: "ROOM4" })]);
    assert.deepEqual([x.status, y.status], ["ACTIVE", "ACTIVE"]);

    const k = key();
    const results = await Promise.all(Array.from({ length: 4 }, () => create(ids.a, { clientKey: k, roomKey: "WORKSHOP" })));
    assert.equal(new Set(results.map((r) => r.shiftId)).size, 1);
    assert.equal(await prisma.shift.count({ where: { roomId: (await prisma.room.findUniqueOrThrow({ where: { key: "WORKSHOP" } })).id } }), 1);
    const workshopShift = results[0].shiftId;
    assert.equal((await chargesOf(workshopShift)).length, 3, "שלושה חיובים בלבד למשמרת שנוצרה פעם אחת");
    assert.equal(await prisma.payment.count({}), 0);
  });

  // ───────────── כישלונות בחיוב הראשון ─────────────

  // ───────────── חיוב חודשי ו-Cron ─────────────

  test("שלושה חיובים בדיוק, כל אחד במועדו ובסכום הקבוע; הריצה היומית אינה מחייבת; אין חיוב רביעי; המשמרת מסתיימת כשהכול שולם", async () => {
    const shiftId = await createOk();
    assert.equal((await cron(new Date("2027-02-20T05:00:00Z"))).outcome, "DONE");
    await cron(MARCH_15);
    const march = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([march.status, march.occurrenceCount, march.amountAgorot, march.dueDate, march.paymentId], ["PENDING", 5, MONTHLY, "2027-03-15", null], "ביום המועד: ממתין לתשלום, בלי חיוב");
    assert.equal(await shiftPayments(), 0);

    await pay(shiftId, "2027-03");
    await pay(shiftId, "2027-04");
    const april = await chargeOf(shiftId, "2027-04");
    assert.deepEqual([april.status, april.occurrenceCount, april.amountAgorot], ["PAID", 4, MONTHLY]);
    // סיום: אחרי סוף התקופה (14.5) והכול שולם. אין חיוב רביעי בשום ריצה
    await cron(new Date("2027-05-14T05:00:00Z"));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE", "ב-14.5 התקופה עוד לא הסתיימה");
    await cron(new Date("2027-05-15T05:00:00Z"));
    await cron(new Date("2027-06-15T05:00:00Z"));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ENDED");
    assert.equal((await chargesOf(shiftId)).length, 3);
    assert.equal(await shiftPayments(), 0);
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, date: { gt: "2027-05-14" } } }), 0);
  });

  test("הרצות Cron מקבילות וריצה נטושה: סימון איחור יחיד לכל חיוב, ו-RUNNING ישנה נלקחת", async () => {
    const shiftId = await createOk();
    const MARCH_16 = new Date(MARCH_15.getTime() + DAY);
    const results = await Promise.all([cron(MARCH_16), cron(MARCH_16), cron(MARCH_16)]);
    assert.ok(results.every((r) => r.outcome === "ALREADY_RUNNING" || r.outcome === "DONE"));
    const march = await chargeOf(shiftId, "2027-03");
    assert.equal(march.status, "FAILED");
    assert.equal(await prisma.auditLog.count({ where: { action: "shift_charge.manual_overdue", entityId: march.id } }), 1, "סימון אחד בלבד");

    await prisma.cronRun.deleteMany({});
    await prisma.cronRun.create({ data: { job: "shift-billing", period: "2027-03", trigger: "dead", status: "RUNNING", startedAt: new Date(MARCH_16.getTime() - 3 * HOUR) } });
    const live = await cron(MARCH_16);
    assert.equal(live.outcome, "DONE");
    assert.equal((await prisma.cronRun.findFirstOrThrow({ where: { trigger: "dead" } })).status, "FAILED");
    await prisma.cronRun.create({ data: { job: "shift-billing", period: "2027-03", trigger: "fresh", status: "RUNNING", startedAt: MARCH_16 } });
    assert.equal((await cron(MARCH_16)).outcome, "ALREADY_RUNNING");
  });

  test("הרצות מתועדות; רק חיוב שלא שולם במועד מסומן כאיחור, ושאר המשמרות לא מושפעות", async () => {
    const a = await createOk(ids.a);
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    await pay(a, "2027-03");
    const run = await cron(new Date(MARCH_15.getTime() + DAY));
    assert.ok(run.outcome === "DONE");
    if (run.outcome === "DONE") assert.deepEqual([run.summary.manualOverdue, run.summary.suspended, run.summary.errors], [1, 0, 0]);
    assert.equal((await chargeOf(a, "2027-03")).status, "PAID");
    assert.deepEqual([(await chargeOf(b, "2027-03")).status, (await chargeOf(b, "2027-03")).failureCode], ["FAILED", "manual_payment_overdue"]);
    const row = await prisma.cronRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    assert.ok(row.finishedAt && row.status === "SUCCEEDED" && (row.summary as { manualOverdue: number }).manualOverdue === 1);
    assert.equal((await views.recentCronRuns(5)).length >= 1, true);
    assert.equal(await shiftPayments(), 0);
  });

  // ───────────── כישלון, חסד והשעיה ─────────────

  test("תשלום שתועד בתקופת החסד מבטל אותה; השעיה אחרי החסד; חידוש מושעית מחייב הסדרה או ויתור מפורש של מנהל", async () => {
    const shiftId = await createOk();
    const MARCH_16 = new Date(MARCH_15.getTime() + DAY);
    await cron(MARCH_16);
    const overdue = await chargeOf(shiftId, "2027-03");
    assert.equal(overdue.status, "FAILED");
    assert.equal(overdue.graceUntil!.getTime() - MARCH_16.getTime(), 7 * DAY);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE", "בתקופת החסד המשמרת פעילה");
    await life.recordManualPayment({ chargeId: overdue.id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-03-17", confirm: true, now: new Date("2027-03-17T09:00:00Z") });
    const paid = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([paid.status, paid.graceUntil, paid.failureCode], ["PAID", null, null]);
    await cron(new Date(MARCH_16.getTime() + 8 * DAY));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE", "החוב הוסדר: אין השעיה");
    await pay(shiftId, "2027-04"); // המשמרת הראשונה משולמת במלואה ואינה חלק מתרחיש ההשעיה שלהלן

    // השעיה (מרץ ואפריל לא שולמו), ואז חידוש. המשבצות נשמרות ואינן פנויות לאחרים
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    const APRIL_16 = new Date(APRIL_15.getTime() + DAY);
    await cron(APRIL_16);
    const r = await cron(new Date(APRIL_16.getTime() + 7 * DAY + HOUR));
    assert.ok(r.outcome === "DONE" && r.summary.suspended === 1, JSON.stringify(r));
    const suspended = await prisma.shift.findUniqueOrThrow({ where: { id: b } });
    assert.equal(suspended.status, "SUSPENDED");
    assert.match(suspended.suspensionReason ?? "", /^payment_failed:2027-0[34]$/);
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId: b, status: "SCHEDULED" } }), SESSIONS, "המשבצות נשמרות");
    await assert.rejects(() => create(ids.c, { roomKey: "ROOM4" }), { code: "CONFLICT" }, "המשבצת מושעית אך חסומה לאחרים");
    const view = (await views.getMyShifts({ userId: ids.b, now: new Date(APRIL_16.getTime() + 8 * DAY) })).shifts[0];
    assert.deepEqual([view.status, view.usable], ["SUSPENDED", false]);
    await assert.rejects(() => life.resumeShift({ shiftId: b, adminId: ids.a }), { code: "FORBIDDEN" });
    await assert.rejects(() => life.resumeShift({ shiftId: b, adminId: ids.admin }), { code: "CONFLICT" }, "חוב לא מוסדר");

    // תיעוד התשלומים מסדיר את החוב אך אינו מחדש את המשמרת בעצמו: חידוש הוא החלטה נפרדת
    const unpaid = await prisma.shiftCharge.findMany({ where: { shiftId: b, status: "FAILED" } });
    assert.equal(unpaid.length, 2, "מרץ ואפריל");
    for (const charge of unpaid) {
      await life.recordManualPayment({ chargeId: charge.id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-04-25", confirm: true, now: new Date("2027-04-25T09:00:00Z") });
      assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: b } })).status, "SUSPENDED");
    }
    await life.resumeShift({ shiftId: b, adminId: ids.admin, now: new Date("2027-04-25T10:00:00Z") });
    const resumed = await prisma.shift.findUniqueOrThrow({ where: { id: b } });
    assert.deepEqual([resumed.status, resumed.suspendedAt, resumed.resumedById], ["ACTIVE", null, ids.admin]);

    // ויתור מפורש: מסמן את החיוב כמוותר ומחדש
    const c = await createOk(ids.a, { roomKey: "WORKSHOP" });
    await cron(MARCH_16);
    await cron(new Date(MARCH_16.getTime() + 8 * DAY));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: c } })).status, "SUSPENDED");
    const res = await life.resumeShift({ shiftId: c, adminId: ids.admin, waiveUnpaid: true, note: "הסכמה" });
    assert.ok(res.waived >= 1);
    assert.equal((await prisma.shiftCharge.findFirstOrThrow({ where: { shiftId: c, status: "WAIVED" } })).resolvedById, ids.admin);
    assert.equal(await shiftPayments(), 0);
  });

  test("רגרסיה: חידוש מושעית אינו נחסם בחיוב עתידי שמועדו טרם הגיע, ואינו מוותר עליו; חיוב שמועדו הגיע עדיין חוסם", async () => {
    const shiftId = await createOk();
    const MARCH_16 = new Date(MARCH_15.getTime() + DAY);
    await cron(MARCH_16);
    await cron(new Date(MARCH_16.getTime() + 7 * DAY + HOUR));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "SUSPENDED");
    assert.equal((await chargeOf(shiftId, "2027-04")).status, "PENDING", "אפריל (15.4) עתידי");

    // מרץ (שמועדו הגיע) עדיין לא שולם: חוסם
    const RESUME_AT = new Date("2027-03-25T10:00:00Z");
    await assert.rejects(() => life.resumeShift({ shiftId, adminId: ids.admin, now: RESUME_AT }), { code: "CONFLICT" });

    // מרץ שולם: החידוש מצליח למרות שאפריל עדיין ממתין, ואפריל נשאר לגבייה במועדו (לא נמחל)
    await life.recordManualPayment({ chargeId: (await chargeOf(shiftId, "2027-03")).id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-03-25", confirm: true, now: RESUME_AT });
    const res = await life.resumeShift({ shiftId, adminId: ids.admin, now: RESUME_AT });
    assert.equal(res.waived, 0);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");
    const april = await chargeOf(shiftId, "2027-04");
    assert.deepEqual([april.status, april.resolvedById], ["PENDING", null]);

    // ויתור בחידוש: רק על מה שמועדו הגיע; החיוב העתידי לא נמחל
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    await cron(MARCH_16);
    await cron(new Date(MARCH_16.getTime() + 7 * DAY + HOUR));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: b } })).status, "SUSPENDED");
    const waived = await life.resumeShift({ shiftId: b, adminId: ids.admin, waiveUnpaid: true, note: "הסכמה", now: RESUME_AT });
    assert.equal(waived.waived, 1, "רק מרץ");
    assert.deepEqual((await chargesOf(b)).map((c) => [c.month, c.status]), [["2027-02", "PAID"], ["2027-03", "WAIVED"], ["2027-04", "PENDING"]]);
  });

  // ───────────── בקשות שינוי וביטול ─────────────

  test("בקשת לקוח אינה משנה דבר: כפילות נדחית, משמרת של אחר מוסתרת, ודחיית מנהל משאירה הכול כפי שהיה", async () => {
    const shiftId = await createOk();
    const snapshot = async () => ({
      shift: await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } }),
      scheduled: await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }),
      confirmed: await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }),
    });
    const before = await snapshot();

    const cancelReq = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL", reason: "עוברת דירה" });
    assert.equal(cancelReq.status, "PENDING");
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" } }), { code: "CONFLICT" }, "בקשה פתוחה אחת");
    await assert.rejects(() => life.createShiftRequest({ userId: ids.b, shiftId, kind: "CANCEL" }), { code: "NOT_FOUND" });
    assert.deepEqual(await snapshot(), before, "הבקשה לא שינתה כלום");
    assert.equal(await prisma.refund.count({}), 0, "אין החזר אוטומטי מבקשת לקוח");

    await assert.rejects(() => life.decideShiftRequest({ requestId: cancelReq.id, adminId: ids.a, decision: "REJECT", provider }), { code: "FORBIDDEN" });
    const rejected = await life.decideShiftRequest({ requestId: cancelReq.id, adminId: ids.admin, decision: "REJECT", note: "לא מאושר", provider });
    assert.equal(rejected.status, "REJECTED");
    assert.deepEqual(await snapshot(), before);
    const stored = await prisma.shiftChangeRequest.findUniqueOrThrow({ where: { id: cancelReq.id } });
    assert.deepEqual([stored.status, stored.decidedById, stored.decisionNote], ["REJECTED", ids.admin, "לא מאושר"]);
    await assert.rejects(() => life.decideShiftRequest({ requestId: cancelReq.id, adminId: ids.admin, decision: "REJECT", provider }), { code: "CONFLICT" }, "כבר טופלה");
    // אחרי דחייה אפשר להגיש בקשה חדשה
    await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" } });
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: {} }), { code: "INVALID" }, "שינוי בלי פירוט");
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "AFTERNOON" } }), { code: "CONFLICT" }, "כבר יש בקשה פתוחה");
  });

  test("אישור בקשת ביטול: מפגשים מהתקופה שטרם שולמה מבוטלים, תקופות ששולמו נשארות בלי החזר, וההיסטוריה נשמרת", async () => {
    const shiftId = await createOk();
    await pay(shiftId, "2027-03"); // התקופה השנייה שולמה
    const req = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL" });
    const res = await life.decideShiftRequest({ requestId: req.id, adminId: ids.admin, decision: "APPROVE", provider, now: new Date("2027-03-20T09:00:00Z") });
    assert.deepEqual([res.status, res.appliedFrom, res.cancelledOccurrences], ["APPROVED", "2027-04-15", 4]);
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.equal(shift.status, "CANCELLED");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "CANCELLED" } }), 4);
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), SESSIONS - 4, "שתי התקופות הראשונות נשארו");
    assert.equal(await prisma.refund.count({}), 0, "בלי החזר אלא אם המנהל ביקש");
    await cron(APRIL_15);
    const april = await chargeOf(shiftId, "2027-04");
    assert.deepEqual([april.status, april.paymentId], ["WAIVED", null], "התקופה שבוטלה כולה אינה מחויבת");
    assert.equal(await shiftPayments(), 0, "אין חיוב מול ספק");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId } }), SESSIONS);
  });

  test("אישור ביטול עם בקשת החזר לתקופה ששולמה ידנית: אין החזר אוטומטי דרך ספק (התשלום לא עבר בו), והמפגשים מסומנים לטיפול ידני", async () => {
    const shiftId = await createOk();
    await pay(shiftId, "2027-03");
    const req = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL" });
    const res = await life.decideShiftRequest({
      requestId: req.id, adminId: ids.admin, decision: "APPROVE", effectiveFrom: "2027-03-22", refundCharged: true, provider, now: new Date("2027-03-20T09:00:00Z"),
    });
    assert.equal(res.cancelledOccurrences, 4 + 4, "22.3, 29.3, 5.4 ו-12.4 (תקופה ששולמה) ואחריהם ארבעת מפגשי התקופה השלישית");
    assert.deepEqual([res.adjust?.refundedAgorot, res.adjust?.refundFailures], [0, 4], "ארבעה מפגשים ששולמו ידנית: ההחזר נעשה ידנית ע\"י ההנהלה");
    const march = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([march.status, march.refundedAgorot], ["PAID", 0]);
    assert.equal(await prisma.refund.count({}), 0);
  });

  test("אישור בקשת שינוי: מוחלף באטומיות מהתקופה שטרם שולמה; התנגשות או תקופה ששולמה מבטלות הכול; מחיר המשבצת החדשה חל מכאן", async () => {
    const shiftId = await createOk();
    await pay(shiftId, "2027-03");
    const now = new Date("2027-03-20T09:00:00Z");

    // שינוי לתקופה ששולמה נדחה
    const paidReq = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" }, requestedFrom: "2027-03-22" });
    await assert.rejects(() => life.decideShiftRequest({ requestId: paidReq.id, adminId: ids.admin, decision: "APPROVE", provider, now }), { code: "CONFLICT" });
    assert.equal((await prisma.shiftChangeRequest.findUniqueOrThrow({ where: { id: paidReq.id } })).status, "PENDING");
    await life.decideShiftRequest({ requestId: paidReq.id, adminId: ids.admin, decision: "REJECT", provider, now });

    // התנגשות בחדר החדש: הכול מתבטל, המשמרת והבקשה כפי שהיו
    await booking.createAppointment({ userId: ids.b, roomKey: "ROOM4", startTime: new Date("2027-04-19T13:00:00+03:00"), endTime: new Date("2027-04-19T14:00:00+03:00"), source: "ADMIN" });
    const blocked = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { roomKey: "ROOM4", windowId: "NOON" } });
    await assert.rejects(() => life.decideShiftRequest({ requestId: blocked.id, adminId: ids.admin, decision: "APPROVE", provider, now }), { code: "CONFLICT" });
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), SESSIONS, "שום מפגש לא שונה");
    assert.equal((await prisma.shiftChangeRequest.findUniqueOrThrow({ where: { id: blocked.id } })).status, "PENDING");
    await life.decideShiftRequest({ requestId: blocked.id, adminId: ids.admin, decision: "REJECT", provider, now });

    // שינוי תקין: משבצת צהריים בחדר 4 מהתקופה השלישית (15.4)
    await prisma.appointment.updateMany({ where: { source: "ADMIN" }, data: { status: "CANCELLED" } });
    const ok = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { roomKey: "ROOM4", windowId: "NOON" } });
    const res = await life.decideShiftRequest({ requestId: ok.id, adminId: ids.admin, decision: "APPROVE", provider, now });
    assert.deepEqual([res.status, res.appliedFrom, res.cancelledOccurrences, res.createdOccurrences], ["APPROVED", "2027-04-15", 4, 4]);
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { room: true } });
    assert.deepEqual([shift.room.key, shift.windowId, shift.monthlyPriceAgorot, shift.occurrencePriceAgorot], ["ROOM4", "NOON", 52500, 13125]);
    const april = await prisma.shiftOccurrence.findMany({ where: { shiftId, month: "2027-04", status: "SCHEDULED" } });
    assert.equal(april.length, 4);
    assert.ok(april.every((o) => o.priceAgorot === 13125 && jerusalemParts(o.startTime).minutes === 11 * 60));
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, month: "2027-03", status: "SCHEDULED" } }), 5, "התקופה ששולמה לא שונתה");
    const april3 = await chargeOf(shiftId, "2027-04");
    assert.deepEqual([april3.amountAgorot, april3.occurrenceCount, april3.status], [52500, 4, "PENDING"], "החיוב השלישי עודכן במעמד האישור למחיר המשבצת החדשה (קבוע)");
    await life.recordManualPayment({ chargeId: april3.id, adminId: ids.admin, amountAgorot: 52500, paidOn: "2027-04-15", confirm: true, now: new Date("2027-04-15T09:00:00Z") });
    assert.equal((await chargeOf(shiftId, "2027-04")).status, "PAID", "תשלום ידני בסכום החדש מתקבל");
    assert.equal((await chargeOf(shiftId, "2027-03")).amountAgorot, MONTHLY, "התקופה ששולמה נשארת");
  });

  // ───────────── עריכת משבצות ומחירים ע"י מנהל ─────────────

  test("עריכת מחיר ושעות: חלה על הזמנות חדשות בלבד; משמרת קיימת, מופעיה וחיוביה נשארים כפי שנקבעו; נרשם ביומן הביקורת", async () => {
    // יומן הביקורת הוא נוספות-בלבד (טריגר חוסם מחיקה), ולכן סופרים את ההפרש ולא ערך מוחלט
    const auditBefore = await prisma.auditLog.count({ where: { entityType: "ShiftWindow", entityId: "MORNING" } });
    const before = await createOk(ids.a); // בוקר 480 ₪
    const windows = await windowsDb.listShiftWindows();
    const edited = windows.map((w) => ({
      id: w.id,
      name: w.name,
      startMinutes: w.startMinutes,
      endMinutes: w.endMinutes,
      monthlyPriceShekel: w.monthlyPriceAgorot / 100,
      active: w.active,
    }));
    edited[0].monthlyPriceShekel = 600;
    edited[0].endMinutes = 10 * 60 + 45; // 07:00–10:45
    await assert.rejects(() => windowsDb.saveShiftWindows({ adminId: ids.admin, windows: edited.map((w) => ({ ...w, monthlyPriceShekel: 10.5 })) }), { code: "INVALID" }, "שקלים שלמים בלבד");
    await windowsDb.saveShiftWindows({ adminId: ids.admin, windows: edited });

    const old = await prisma.shift.findUniqueOrThrow({ where: { id: before }, include: { occurrences: true } });
    assert.equal(old.monthlyPriceAgorot, MONTHLY, "המחיר שנקבע בעת ההזמנה נשמר");
    assert.ok(old.occurrences.every((o) => jerusalemParts(o.endTime).minutes === 11 * 60), "שעות המופעים הקיימים לא השתנו");
    await cron(MARCH_15);
    assert.equal((await chargeOf(before, "2027-03")).amountAgorot, MONTHLY, "החיוב החודשי של משמרת קיימת לא השתנה");

    const fresh = await createOk(ids.b, { roomKey: "ROOM4" });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: fresh }, include: { occurrences: true } });
    assert.equal(shift.monthlyPriceAgorot, 60000);
    assert.ok(shift.occurrences.every((o) => jerusalemParts(o.endTime).minutes === 10 * 60 + 45));
    assert.equal((await chargeOf(fresh, "2027-02")).amountAgorot, 60000, "החיוב הראשון לפי המחיר החדש (קבוע)");

    const audit = await prisma.auditLog.findMany({ where: { entityType: "ShiftWindow", entityId: "MORNING" } });
    assert.equal(audit.length - auditBefore, 1);
    const last = audit.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    assert.deepEqual([last.action, last.adminId, last.outcome], ["shift_window.update", ids.admin, "ok"]);
  });

  test("משבצת מושבתת: לא ניתן להזמין אותה ולא לעבור אליה, אך משמרת קיימת בה ממשיכה לפעול ואפשר לשנות לה חדר", async () => {
    const existing = await createOk(ids.a, { windowId: "NOON" });
    const windows = (await windowsDb.listShiftWindows()).map((w) => ({
      id: w.id, name: w.name, startMinutes: w.startMinutes, endMinutes: w.endMinutes, monthlyPriceShekel: w.monthlyPriceAgorot / 100, active: w.id === "NOON" ? false : w.active,
    }));
    await windowsDb.saveShiftWindows({ adminId: ids.admin, windows });

    await assert.rejects(() => create(ids.b, { windowId: "NOON", roomKey: "ROOM4" }), { code: "INVALID" });
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId: existing, kind: "CHANGE", proposed: { windowId: "NOON" } }), { code: "INVALID" }, "אי אפשר לבקש מעבר למשבצת מושבתת");
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: existing } })).status, "ACTIVE");

    const req = await life.createShiftRequest({ userId: ids.a, shiftId: existing, kind: "CHANGE", proposed: { roomKey: "ROOM1" } });
    const res = await life.decideShiftRequest({ requestId: req.id, adminId: ids.admin, decision: "APPROVE", provider, now: new Date("2027-02-20T09:00:00Z") });
    assert.equal(res.status, "APPROVED");
    const moved = await prisma.shift.findUniqueOrThrow({ where: { id: existing }, include: { room: true } });
    assert.deepEqual([moved.room.key, moved.windowId], ["ROOM1", "NOON"]);
  });

  test("בקשת שינוי שאינה כוללת מעבר משבצת ממשיכה לתמחר לפי המחיר שכבר אושר, גם אם מחיר המשבצת נערך במקום אחרי ההזמנה; מעבר מפורש למשבצת אחרת כן מתמחר לפיה", async () => {
    const shiftId = await createOk(ids.a); // בוקר (MORNING), 480 ₪
    const windows = await windowsDb.listShiftWindows();
    const edited = windows.map((w) => ({
      id: w.id, name: w.name, startMinutes: w.startMinutes, endMinutes: w.endMinutes, monthlyPriceShekel: w.monthlyPriceAgorot / 100, active: w.active,
    }));
    // עריכה במקום (לא יצירת משבצת חדשה): אותו id ("MORNING"), מחיר אחר. זו בדיוק התרחיש שה-bug המקורי היה פגיע בו
    edited.find((w) => w.id === "MORNING")!.monthlyPriceShekel = 999;
    await windowsDb.saveShiftWindows({ adminId: ids.admin, windows: edited });

    // בקשת שינוי שאינה נוגעת למשבצת (רק חדר) אושרה; המחיר חייב להישאר המקורי (480), לא 999 שנערך במקום
    const roomOnly = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { roomKey: "ROOM4" } });
    const res1 = await life.decideShiftRequest({ requestId: roomOnly.id, adminId: ids.admin, decision: "APPROVE", provider, now: new Date("2027-02-20T09:00:00Z") });
    assert.equal(res1.status, "APPROVED");
    const afterRoomChange = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { room: true, occurrences: true } });
    assert.deepEqual([afterRoomChange.room.key, afterRoomChange.windowId, afterRoomChange.monthlyPriceAgorot, afterRoomChange.occurrencePriceAgorot], ["ROOM4", "MORNING", MONTHLY, Math.round(MONTHLY / 4)]);
    assert.ok(
      afterRoomChange.occurrences.filter((o) => o.status === "SCHEDULED").every((o) => o.priceAgorot === Math.round(MONTHLY / 4) || o.priceAgorot === Math.round(MONTHLY / 5)),
      "מחיר המופעים שנוצרו מחדש בשינוי עדיין לפי 480, לא 999"
    );

    // מעבר מפורש למשבצת אחרת (NOON): זו אישור מפורש למחיר החדש, ולכן כן חל
    const toNoon = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" } });
    const res2 = await life.decideShiftRequest({ requestId: toNoon.id, adminId: ids.admin, decision: "APPROVE", provider, now: new Date("2027-02-21T09:00:00Z") });
    assert.equal(res2.status, "APPROVED");
    const afterWindowChange = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.deepEqual([afterWindowChange.windowId, afterWindowChange.monthlyPriceAgorot], ["NOON", 52500]);
  });

  test("שמירת משבצות: חפיפה, אי-פעילות מלאה ושעות לא תקינות נדחות; הוספת משבצת חדשה נרשמת; משבצת שהוסרה מהרשימה מושבתת ולא נמחקת", async () => {
    const current = (await windowsDb.listShiftWindows()).map((w) => ({
      id: w.id, name: w.name, startMinutes: w.startMinutes, endMinutes: w.endMinutes, monthlyPriceShekel: w.monthlyPriceAgorot / 100, active: w.active,
    }));
    const auditBefore = await prisma.auditLog.count({ where: { entityType: "ShiftWindow" } });
    const overlap = current.map((w, i) => (i === 1 ? { ...w, startMinutes: 10 * 60 } : w));
    await assert.rejects(() => windowsDb.saveShiftWindows({ adminId: ids.admin, windows: overlap }), { code: "INVALID" }, "חפיפה");
    await assert.rejects(() => windowsDb.saveShiftWindows({ adminId: ids.admin, windows: current.map((w) => ({ ...w, active: false })) }), { code: "INVALID" }, "אין משבצת פעילה");
    await assert.rejects(() => windowsDb.saveShiftWindows({ adminId: ids.admin, windows: current.map((w, i) => (i === 0 ? { ...w, startMinutes: 7 * 60 + 7 } : w)) }), { code: "INVALID" }, "לא בקפיצות רבע שעה");
    await assert.rejects(() => windowsDb.saveShiftWindows({ adminId: ids.admin, windows: [...current, { id: "NOPE", name: "x", startMinutes: 0, endMinutes: 60, monthlyPriceShekel: 100, active: true }] }), { code: "NOT_FOUND" });
    assert.equal(await prisma.auditLog.count({ where: { entityType: "ShiftWindow" } }), auditBefore, "שמירה שנכשלה אינה משאירה רישום או שינוי");

    const withNew = [...current.slice(0, 3), { name: "לילה", startMinutes: 23 * 60, endMinutes: 24 * 60, monthlyPriceShekel: 200, active: true }];
    const saved = await windowsDb.saveShiftWindows({ adminId: ids.admin, windows: withNew });
    assert.equal(saved.length, 5, "המשבצת שהוסרה (ערב) נשארת, מושבתת");
    assert.equal(saved.find((w) => w.id === "EVENING")!.active, false);
    assert.equal(saved.find((w) => w.name === "לילה")!.monthlyPriceAgorot, 20000);
    assert.equal((await prisma.auditLog.count({ where: { entityType: "ShiftWindow" } })) - auditBefore, 2, "יצירה אחת והשבתה אחת");
  });

  // ───────────── שעות חלופיות: זיכוי בדקות ─────────────

  /** משמרת פעילה עם מפגש שנסגר: מחזיר את המפגש והזיכוי שנוצר */
  async function closedOccurrence(userId: string, over: Over, date: string) {
    const shiftId = await createOk(userId, over);
    await life.applyDayClosure({ date, adminId: ids.admin, now: new Date("2027-03-05T09:00:00Z") });
    const occ = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId, date } } });
    const credit = await prisma.credit.findUniqueOrThrow({ where: { id: occ.makeupCreditId! } });
    return { shiftId, occ, credit };
  }

  test("שעות חלופיות: הלקוח זכאי למלוא משך המפגש שבוטל (4 שעות = 240 דקות, 3 שעות = 180), בלי שינוי בשלושת החיובים", async () => {
    const morning = await closedOccurrence(ids.a, {}, "2027-03-08"); // בוקר 07:00–11:00
    assert.deepEqual([morning.credit.minutesTotal, morning.credit.minutesRemaining], [240, 240]);
    const evening = await closedOccurrence(ids.b, { windowId: "EVENING", roomKey: "ROOM2" }, "2027-03-08"); // ערב 19:00–22:00
    assert.deepEqual([evening.credit.minutesTotal, evening.credit.minutesRemaining], [180, 180]);
    assert.ok(morning.credit.expiresAt.getTime() > Date.now(), "הזיכוי בתוקף");
    // סגירה חוזרת (אידמפוטנטית) אינה מכפילה זיכוי
    await life.applyDayClosure({ date: "2027-03-08", adminId: ids.admin });
    assert.equal(await prisma.credit.count({ where: { reason: { startsWith: "shift_makeup:" } } }), 2);
    for (const shiftId of [morning.shiftId, evening.shiftId]) {
      assert.deepEqual((await chargesOf(shiftId)).map((c) => [c.amountAgorot, c.refundedAgorot]).flat().filter((x, i) => i % 2 === 1), [0, 0, 0]);
    }
    assert.equal(await prisma.refund.count({}), 0);
    // קלנדר/רשת ביטחון: ריצה יומית אינה יוצרת זיכוי נוסף
    await cron(MARCH_15);
    assert.equal(await prisma.credit.count({ where: { reason: { startsWith: "shift_makeup:" } } }), 2);
  });

  test("שעות חלופיות: שיבוץ ע\"י מנהל גורע מהיתרה בלבד, בלי ניצול כפול ובלי חריגה; שני שיבוצים מקבילים על אותה יתרה — רק אחד מצליח", async () => {
    const { occ } = await closedOccurrence(ids.a, {}, "2027-03-08");
    const slot = (day: string, hour: number, minutes: number) => ({
      startTime: new Date(day + "T" + String(hour).padStart(2, "0") + ":00:00+02:00"),
      endTime: new Date(new Date(day + "T" + String(hour).padStart(2, "0") + ":00:00+02:00").getTime() + minutes * 60_000),
    });
    const credit = () => prisma.credit.findUniqueOrThrow({ where: { id: occ.makeupCreditId! } });
    const remaining = async () => (await credit()).minutesRemaining;

    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.a, roomKey: "ROOM3", ...slot("2027-03-09", 9, 60) }), { code: "FORBIDDEN" });
    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM3", ...slot("2027-03-09", 9, 50) }), { code: "INVALID" }, "לא מכפלה של רבע שעה");
    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM3", ...slot("2027-03-09", 9, 300) }), { code: "CONFLICT" }, "יותר מהיתרה (300 מתוך 240)");
    assert.equal(await remaining(), 240, "ניסיונות שנכשלו לא גרעו כלום");
    assert.equal(await prisma.appointment.count({ where: { notes: { contains: "שעה חלופית" }, status: "CONFIRMED" } }), 0, "וההזמנה שנוצרה לפני הכישלון בוטלה");

    const first = await life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM3", ...slot("2027-03-09", 9, 120) });
    assert.deepEqual([first.minutes, first.remainingMinutes], [120, 120]);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: first.appointmentId } });
    assert.deepEqual([appt.status, appt.userId, appt.paidFromBalanceMinutes, appt.paymentStatus, appt.source], ["CONFIRMED", ids.a, 120, "PAID", "ADMIN"]);
    assert.equal(await prisma.creditUsage.count({ where: { creditId: occ.makeupCreditId!, kind: "CONSUME", appointmentId: first.appointmentId } }), 1);

    // שני שיבוצים מקבילים של 90 דקות על יתרה של 120: אחד בלבד מצליח
    const results = await Promise.allSettled([
      life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM4", ...slot("2027-03-10", 9, 90) }),
      life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM4", ...slot("2027-03-11", 9, 90) }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await remaining(), 30);
    assert.equal(await prisma.appointment.count({ where: { notes: { contains: "שעה חלופית" }, status: "CONFIRMED" } }), 2, "ההזמנה שנכשלה בוטלה");
    // ניצול היתרה עד תומה: הסטטוס עובר ל"שובץ", ואין שיבוץ נוסף
    await life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM1", ...slot("2027-03-12", 9, 30) });
    assert.deepEqual([await remaining(), (await prisma.shiftOccurrence.findUniqueOrThrow({ where: { id: occ.id } })).makeupStatus], [0, "ARRANGED"]);
    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM1", ...slot("2027-03-12", 14, 15) }), { code: "CONFLICT" });
    const view = (await views.getMyShifts({ userId: ids.a, now: new Date("2027-03-09T09:00:00Z") })).shifts[0];
    assert.deepEqual([view.makeups[0].state, view.makeups[0].minutesRemaining, view.makeupOwed], ["USED", 0, 0]);
    assert.equal(await prisma.auditLog.count({ where: { action: "shift_makeup.scheduled", entityId: occ.id } }) >= 3, true);
    assert.equal((await prisma.shiftCharge.findMany({ where: { shiftId: occ.shiftId } })).every((c) => c.amountAgorot === MONTHLY && c.refundedAgorot === 0), true, "החיובים לא השתנו");
  });

  test("שעות חלופיות: ויתור מפורש מאפס את היתרה (פעם אחת, מנהל בלבד, ביומן); זיכוי שפג אינו ניתן לשיבוץ; הלקוח מממש דרך אישור מהיתרה", async () => {
    const waived = await closedOccurrence(ids.a, {}, "2027-03-08");
    await assert.rejects(() => life.waiveOccurrenceMakeup({ occurrenceId: waived.occ.id, adminId: ids.a }), { code: "FORBIDDEN" });
    const res = await life.waiveOccurrenceMakeup({ occurrenceId: waived.occ.id, adminId: ids.admin, note: "הלקוח ויתר" });
    assert.deepEqual([res.makeupStatus, res.waivedMinutes], ["WAIVED", 240]);
    assert.equal((await prisma.credit.findUniqueOrThrow({ where: { id: waived.credit.id } })).minutesRemaining, 0);
    await assert.rejects(() => life.waiveOccurrenceMakeup({ occurrenceId: waived.occ.id, adminId: ids.admin }), { code: "CONFLICT" });
    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: waived.occ.id, adminId: ids.admin, roomKey: "ROOM3", startTime: new Date("2027-03-09T09:00:00+02:00"), endTime: new Date("2027-03-09T10:00:00+02:00") }), { code: "CONFLICT" });
    assert.equal(await prisma.auditLog.count({ where: { action: "shift_makeup.waived", entityId: waived.occ.id } }), 1);

    // זיכוי שפג תוקפו
    const expired = await closedOccurrence(ids.b, { roomKey: "ROOM4" }, "2027-03-08");
    await prisma.credit.update({ where: { id: expired.credit.id }, data: { expiresAt: new Date(Date.now() - HOUR) } });
    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: expired.occ.id, adminId: ids.admin, roomKey: "ROOM2", startTime: new Date("2027-03-09T09:00:00+02:00"), endTime: new Date("2027-03-09T10:00:00+02:00") }), { code: "CONFLICT" });
    assert.equal((await views.getMyShifts({ userId: ids.b, now: new Date() })).shifts[0].makeups[0].state, "EXPIRED");

    // מימוש עצמי של הלקוח: החזקה ואישור מהיתרה (אותו מסלול של כל יתרת דקות), בלי ניצול כפול
    const own = await closedOccurrence(ids.female, { weekday: 2, roomKey: "ROOM1" }, "2027-03-09");
    const hold = await payBooking.holdRoom({ userId: ids.female, roomKey: "ROOM2", startTime: new Date("2027-03-11T12:00:00+02:00"), endTime: new Date("2027-03-11T13:00:00+02:00"), source: "WEB", now: NOW });
    const confirmed = await payBooking.confirmBookingFromBalance({ appointmentId: hold.id, userId: ids.female, provider, now: NOW });
    assert.equal(confirmed.outcome, "CONFIRMED");
    assert.equal((await prisma.credit.findUniqueOrThrow({ where: { id: own.credit.id } })).minutesRemaining, own.credit.minutesTotal - 60);
    const view = (await views.getMyShifts({ userId: ids.female, now: NOW })).shifts[0];
    assert.deepEqual([view.makeups[0].state, view.makeups[0].minutesRemaining, view.makeupMinutesRemaining], ["OPEN", own.credit.minutesTotal - 60, own.credit.minutesTotal - 60]);
  });

  test("שעות חלופיות: משמרת ישנה שממתינה לתשלום הראשון אינה מקבלת זיכוי; זיכוי ניתן כשהיא מאושרת, ולא בכלל אם בוטלה", async () => {
    // משמרות חדשות מאושרות מיד; מצב PENDING קיים רק בנתונים מלפני הסרת החיוב האוטומטי, ולכן נוצר כאן ישירות
    const pending = await create(ids.a);
    await prisma.shift.update({ where: { id: pending.shiftId }, data: { status: "PENDING" } });
    await life.applyDayClosure({ date: "2027-03-08", adminId: ids.admin, now: NOW });
    const occ = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId: pending.shiftId, date: "2027-03-08" } } });
    assert.deepEqual([occ.makeupStatus, occ.makeupCreditId], ["OWED", null]);
    assert.equal(await prisma.credit.count({ where: { userId: ids.a } }), 0, "אין זיכוי לפני אישור התשלום הראשון");
    await pay(pending.shiftId, "2027-02");
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: pending.shiftId } })).status, "ACTIVE", "תיעוד התשלום הראשון מאשר את המשמרת");
    const granted = await prisma.credit.findMany({ where: { userId: ids.a } });
    assert.deepEqual(granted.map((c) => c.minutesTotal), [240], "אחרי האישור ניתן זיכוי");

    // משמרת ישנה שהתשלום הראשון שלה במצב לא ידוע, והוכרע "לא חויב": משוחררת, בלי זיכוי
    const failed = await create(ids.b, { roomKey: "ROOM4" });
    await prisma.shift.update({ where: { id: failed.shiftId }, data: { status: "PENDING" } });
    await prisma.shiftCharge.update({ where: { shiftId_month: { shiftId: failed.shiftId, month: "2027-02" } }, data: { status: "UNKNOWN" } });
    await life.applyDayClosure({ date: "2027-03-08", adminId: ids.admin, now: NOW });
    await life.resolveUnknownCharge({ chargeId: (await chargeOf(failed.shiftId, "2027-02")).id, adminId: ids.admin, outcome: "NOT_CHARGED", now: NOW });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: failed.shiftId } })).status, "CANCELLED");
    const none = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId: failed.shiftId, date: "2027-03-08" } } });
    assert.deepEqual([none.makeupStatus, none.makeupCreditId], [null, null]);
    assert.equal(await prisma.credit.count({ where: { userId: ids.b } }), 0);
  });

  // ───────────── יתרות: שעות חלופיות לצד שעות בתשלום ─────────────

  const book = (userId: string, room: "ROOM1" | "ROOM2" | "ROOM3" | "ROOM4", day: string, from: string, to: string, tz: string, now: Date) =>
    payBooking.holdRoom({ userId, roomKey: room, startTime: new Date(day + "T" + from + ":00" + tz), endTime: new Date(day + "T" + to + ":00" + tz), source: "WEB", now });

  test("יתרות: זיכוי של 90 יום מנוצל לפני חבילה שפוקעת מאוחר, פקיעתו אינה נוגעת בחבילה, זיכוי שפג אינו ניתן למימוש, ואי אפשר לחרוג מהיתרה", async () => {
    const { credit } = await closedOccurrence(ids.a, {}, "2027-03-08");
    assert.equal(credit.expiresAt.getTime() - new Date("2027-03-05T09:00:00Z").getTime(), 90 * DAY, "תוקף: בדיוק 90 יום ממועד מתן הזיכוי");
    const pkg = await prisma.hoursPackage.create({
      data: { userId: ids.a, hours: 10, pricePaidAgorot: 36400, minutesTotal: 600, minutesRemaining: 600, expiresAt: new Date("2028-02-15T00:00:00Z") },
    });
    const { getBalanceView } = await import("@/lib/payments/views");
    const remainingOf = async () => ({
      credit: (await prisma.credit.findUniqueOrThrow({ where: { id: credit.id } })).minutesRemaining,
      pkg: (await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining,
    });
    const day1 = new Date("2027-03-06T09:00:00Z");
    assert.equal((await getBalanceView(ids.a, day1)).totalMinutes, 240 + 600);

    // הפוקע ראשון מנוצל ראשון: הזיכוי (90 יום) לפני החבילה (שנה)
    const h1 = await book(ids.a, "ROOM2", "2027-03-10", "12:00", "13:00", "+02:00", day1);
    assert.equal((await payBooking.confirmBookingFromBalance({ appointmentId: h1.id, userId: ids.a, provider, now: day1 })).outcome, "CONFIRMED");
    assert.deepEqual(await remainingOf(), { credit: 180, pkg: 600 });

    // אחרי 90 יום הזיכוי פג בפועל: אינו מוצג ביתרה, אינו מנוצל, והחבילה לא נפגעת
    const late = new Date("2027-06-04T09:00:00Z");
    const view = await getBalanceView(ids.a, late);
    assert.equal(view.totalMinutes, 600, "הזיכוי שפג לא נספר");
    assert.deepEqual(view.expiredCredits.map((c) => c.id), [credit.id]);
    const h2 = await book(ids.a, "ROOM2", "2027-06-09", "12:00", "13:00", "+03:00", late);
    assert.equal((await payBooking.confirmBookingFromBalance({ appointmentId: h2.id, userId: ids.a, provider, now: late })).outcome, "CONFIRMED");
    assert.deepEqual(await remainingOf(), { credit: 180, pkg: 540 }, "המימוש נעשה מהחבילה; הזיכוי שפג לא נגע");
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).expiresAt.toISOString(), "2028-02-15T00:00:00.000Z");
    // שיבוץ מנהל מזיכוי שפג נדחה בשרת (ולא רק מוסתר בממשק)
    const occ = await prisma.shiftOccurrence.findFirstOrThrow({ where: { makeupCreditId: credit.id } });
    await prisma.credit.update({ where: { id: credit.id }, data: { expiresAt: new Date(Date.now() - HOUR) } });
    await assert.rejects(() => life.scheduleMakeupSession({ occurrenceId: occ.id, adminId: ids.admin, roomKey: "ROOM4", startTime: new Date("2027-06-10T09:00:00+03:00"), endTime: new Date("2027-06-10T10:00:00+03:00") }), { code: "CONFLICT" });
    assert.equal((await remainingOf()).credit, 180);
  });

  test("יתרות: אי אפשר לנצל שעות חלופיות מעבר ליתרה — הזמנה גדולה מהיתרה נדחית בלי ניכוי חלקי, והיתרה לא יורדת מתחת לאפס", async () => {
    const { credit } = await closedOccurrence(ids.a, {}, "2027-03-08"); // 240 דקות
    const day = new Date("2027-03-06T09:00:00Z");
    const left = async () => (await prisma.credit.findUniqueOrThrow({ where: { id: credit.id } })).minutesRemaining;
    const a = await book(ids.a, "ROOM2", "2027-03-10", "08:00", "11:00", "+02:00", day); // 180
    await payBooking.confirmBookingFromBalance({ appointmentId: a.id, userId: ids.a, provider, now: day });
    assert.equal(await left(), 60);
    const b = await book(ids.a, "ROOM3", "2027-03-10", "08:00", "10:00", "+02:00", day); // 120 > 60
    await assert.rejects(() => payBooking.confirmBookingFromBalance({ appointmentId: b.id, userId: ids.a, provider, now: day }), { code: "INSUFFICIENT_BALANCE" });
    assert.equal(await left(), 60, "אין ניכוי חלקי");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: b.id } })).status, "PENDING_PAYMENT", "ההזמנה לא אושרה");
    // שני אישורים מקבילים של 60 דקות על יתרה של 60: אחד בלבד מצליח
    const c1 = await book(ids.a, "ROOM1", "2027-03-12", "08:00", "09:00", "+02:00", day);
    const c2 = await book(ids.a, "ROOM2", "2027-03-12", "10:00", "11:00", "+02:00", day);
    const settled = await Promise.allSettled([c1, c2].map((h) => payBooking.confirmBookingFromBalance({ appointmentId: h.id, userId: ids.a, provider, now: day })));
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await left(), 0);
    assert.equal((await prisma.creditUsage.aggregate({ where: { creditId: credit.id, kind: "CONSUME" }, _sum: { minutes: true } }))._sum.minutes, 240, "סך הניצול בדיוק כגודל הזיכוי");
  });

  test("ויתור מנהל על שעה חלופית שנוצלה חלקית: היתרה מתאפסת, והדקות שנוצלו לא חוזרות לשימוש ולא הופכות לזיכוי חדש גם אם ההזמנה מבוטלת אחר כך", async () => {
    const { credit, occ } = await closedOccurrence(ids.a, {}, "2027-03-08"); // 240 דקות
    const day = new Date("2027-03-06T09:00:00Z");
    const creditNow = () => prisma.credit.findUniqueOrThrow({ where: { id: credit.id } });
    const used1 = await book(ids.a, "ROOM2", "2027-03-10", "12:00", "13:00", "+02:00", day);
    const used2 = await book(ids.a, "ROOM2", "2027-03-10", "14:00", "15:00", "+02:00", day);
    for (const h of [used1, used2]) await payBooking.confirmBookingFromBalance({ appointmentId: h.id, userId: ids.a, provider, now: day });
    assert.equal((await creditNow()).minutesRemaining, 120);

    const waived = await life.waiveOccurrenceMakeup({ occurrenceId: occ.id, adminId: ids.admin, note: "ויתור", now: day });
    assert.equal(waived.waivedMinutes, 120, "רק היתרה שטרם נוצלה מבוטלת");
    assert.equal((await creditNow()).minutesRemaining, 0);
    const view = (await views.getMyShifts({ userId: ids.a, now: day })).shifts[0];
    assert.deepEqual([view.makeups[0].state, view.makeupMinutesRemaining, view.makeupOwed], ["WAIVED", 0, 0]);

    // ביטול (24 שעות ומעלה) אחרי הוויתור: הדקות אינן חוזרות, ואין זיכוי חדש, וההזמנה כן מבוטלת
    const cancelled = await payBooking.cancelBooking({ appointmentId: used1.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: new Date("2027-03-07T09:00:00Z") });
    assert.deepEqual([cancelled.outcome, cancelled.minutesRestored, cancelled.creditedMinutes], ["MINUTES_RESTORED", 0, 0]);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: used1.id } })).status, "CANCELLED");
    assert.equal((await creditNow()).minutesRemaining, 0, "השעות שויתר עליהן לא חזרו לשימוש");
    assert.equal(await prisma.credit.count({ where: { userId: ids.a } }), 1, "ולא נוצר זיכוי חדש");
    // אידמפוטנטי: ביטול חוזר וחריג מנהל אינם משנים כלום
    await payBooking.cancelBooking({ appointmentId: used1.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: new Date("2027-03-07T10:00:00Z") });
    await payBooking.approveCancellationRefund({ appointmentId: used1.id, adminId: ids.admin, provider, now: new Date("2027-03-07T11:00:00Z") });
    assert.deepEqual([(await creditNow()).minutesRemaining, await prisma.credit.count({ where: { userId: ids.a } })], [0, 1]);
    // לא ניתן לממש יותר: אין יתרה
    const again = await book(ids.a, "ROOM2", "2027-03-10", "16:00", "17:00", "+02:00", day);
    await assert.rejects(() => payBooking.confirmBookingFromBalance({ appointmentId: again.id, userId: ids.a, provider, now: day }), { code: "INSUFFICIENT_BALANCE" });

    // ביטול לפני ויתור: הדקות חוזרות ואז הוויתור מאפס אותן (אין דרך לעקוף)
    const other = await closedOccurrence(ids.b, { roomKey: "ROOM4" }, "2027-03-08");
    const hb = await book(ids.b, "ROOM3", "2027-03-10", "12:00", "13:00", "+02:00", day);
    await payBooking.confirmBookingFromBalance({ appointmentId: hb.id, userId: ids.b, provider, now: day });
    await payBooking.cancelBooking({ appointmentId: hb.id, requester: { id: ids.b, role: "CLIENT" }, provider, now: new Date("2027-03-07T09:00:00Z") });
    assert.equal((await prisma.credit.findUniqueOrThrow({ where: { id: other.credit.id } })).minutesRemaining, 240);
    const w2 = await life.waiveOccurrenceMakeup({ occurrenceId: other.occ.id, adminId: ids.admin, now: day });
    assert.equal(w2.waivedMinutes, 240);
    assert.equal((await prisma.credit.findUniqueOrThrow({ where: { id: other.credit.id } })).minutesRemaining, 0);
  });

  test("ביטול הזמנה ששולמה מזיכוי שעות חלופיות: הדקות חוזרות לזיכוי המקורי בלי הארכת תוקף; זיכוי שפג מוחלף בזיכוי של 30 יום (מדיניות קיימת); אין החזרה כפולה", async () => {
    const { credit } = await closedOccurrence(ids.a, {}, "2027-03-08");
    const originalExpiry = credit.expiresAt.getTime();
    const creditNow = async () => prisma.credit.findUniqueOrThrow({ where: { id: credit.id } });
    const day = new Date("2027-03-06T09:00:00Z");

    const h1 = await book(ids.a, "ROOM2", "2027-03-10", "12:00", "13:00", "+02:00", day);
    await payBooking.confirmBookingFromBalance({ appointmentId: h1.id, userId: ids.a, provider, now: day });
    assert.equal((await creditNow()).minutesRemaining, 180);
    // ביטול 24 שעות ומעלה לפני ההתחלה: חוזר למקור (בתוקף), התוקף לא משתנה
    const c1 = await payBooking.cancelBooking({ appointmentId: h1.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: new Date("2027-03-07T09:00:00Z") });
    assert.deepEqual([c1.outcome, c1.minutesRestored, c1.creditedMinutes], ["MINUTES_RESTORED", 60, 0]);
    const restored = await creditNow();
    assert.deepEqual([restored.minutesRemaining, restored.expiresAt.getTime()], [240, originalExpiry], "אין הארכת תוקף");
    // ביטול חוזר ואישור חריג מנהל לא מחזירים פעם שנייה
    assert.equal((await payBooking.cancelBooking({ appointmentId: h1.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: new Date("2027-03-07T10:00:00Z") })).outcome, "ALREADY_CANCELLED");
    await payBooking.approveCancellationRefund({ appointmentId: h1.id, adminId: ids.admin, provider, now: new Date("2027-03-07T11:00:00Z") });
    assert.equal((await creditNow()).minutesRemaining, 240, "אין החזרה כפולה");
    assert.equal(await prisma.credit.count({ where: { userId: ids.a } }), 1);

    // ביטול מאוחר (פחות מ-24 שעות): בלי החזרה
    const h2 = await book(ids.a, "ROOM2", "2027-03-10", "14:00", "15:00", "+02:00", day);
    await payBooking.confirmBookingFromBalance({ appointmentId: h2.id, userId: ids.a, provider, now: day });
    const late = await payBooking.cancelBooking({ appointmentId: h2.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: new Date("2027-03-10T08:00:00Z") });
    assert.deepEqual([late.outcome, late.minutesRestored], ["CANCELLED_NO_REFUND", 0]);
    assert.equal((await creditNow()).minutesRemaining, 180);

    // הזיכוי פג לפני הביטול: המקור אינו מוארך; הדקות הופכות לזיכוי חדש של 30 יום מרגע הביטול
    const h3 = await book(ids.a, "ROOM1", "2027-03-12", "09:00", "10:00", "+02:00", day);
    await payBooking.confirmBookingFromBalance({ appointmentId: h3.id, userId: ids.a, provider, now: day });
    const expiredAt = new Date("2027-03-07T10:00:00Z");
    await prisma.credit.update({ where: { id: credit.id }, data: { expiresAt: expiredAt } });
    const cancelAt = new Date("2027-03-08T09:00:00Z");
    const c3 = await payBooking.cancelBooking({ appointmentId: h3.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: cancelAt });
    assert.deepEqual([c3.outcome, c3.minutesRestored, c3.creditedMinutes], ["MINUTES_RESTORED", 0, 60]);
    const original = await creditNow();
    assert.deepEqual([original.minutesRemaining, original.expiresAt.getTime()], [120, expiredAt.getTime()], "הזיכוי המקורי לא הוארך ולא קיבל דקות");
    const replacement = await prisma.credit.findFirstOrThrow({ where: { userId: ids.a, reason: "restored_from_expired_balance" } });
    assert.deepEqual([replacement.minutesRemaining, replacement.expiresAt.getTime() - cancelAt.getTime()], [60, 30 * DAY]);
    assert.equal((await payBooking.cancelBooking({ appointmentId: h3.id, requester: { id: ids.a, role: "CLIENT" }, provider, now: cancelAt })).outcome, "ALREADY_CANCELLED");
    assert.equal(await prisma.credit.count({ where: { userId: ids.a, reason: "restored_from_expired_balance" } }), 1);
  });

  // ───────────── תשלום ידני שלא התקבל במועד ─────────────

  test("תשלום ידני שלא התקבל במועד נכנס למנגנון החובות: תקופת חסד של 7 ימים, השעיה, וניקוי באישור מנהל; הכול ביומן הביקורת", async () => {
    const res = await create(ids.c);
    const shiftId = res.shiftId;
    assert.equal(await prisma.auditLog.count({ where: { action: "shift.create_manual", entityId: shiftId } }), 1);

    // ביום המועד (15.2) עוד אין איחור; ביום שאחריו החיוב עובר לכישלון ומתחילה תקופת חסד
    await cron(new Date("2027-02-15T20:00:00Z"));
    assert.equal((await chargeOf(shiftId, "2027-02")).status, "PENDING");
    const overdueAt = new Date("2027-02-16T05:00:00Z");
    const r = await cron(overdueAt);
    assert.ok(r.outcome === "DONE" && r.summary.manualOverdue === 1, JSON.stringify(r));
    const overdue = await chargeOf(shiftId, "2027-02");
    assert.deepEqual([overdue.status, overdue.failureCode], ["FAILED", "manual_payment_overdue"]);
    assert.equal(overdue.graceUntil!.getTime() - overdueAt.getTime(), 7 * DAY);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE", "בתקופת החסד המשמרת פעילה");
    assert.equal(await prisma.auditLog.count({ where: { action: "shift_charge.manual_overdue", entityId: overdue.id } }), 1);
    await cron(new Date("2027-02-16T15:00:00Z"));
    assert.equal(await prisma.auditLog.count({ where: { action: "shift_charge.manual_overdue", entityId: overdue.id } }), 1, "אי-איחור כפול");
    assert.equal(await prisma.payment.count({ where: { userId: ids.c } }), 0, "אין שום חיוב אוטומטי");

    // הכספים: החוב מופיע כחוב שטרם נגבה
    const sf = await views.listShiftsAdmin({ status: "ACTIVE" }, undefined, overdueAt);
    assert.deepEqual(sf.map((x) => [x.id, x.unpaidCharges]), [[shiftId, 1]]);

    // אחרי 7 ימים בלי תשלום: השעיה (נרשמת ביומן), והמשבצות נשמרות
    const r2 = await cron(new Date("2027-02-23T06:00:00Z"));
    assert.ok(r2.outcome === "DONE" && r2.summary.suspended === 1, JSON.stringify(r2));
    assert.deepEqual([(await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, (await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).suspensionReason], ["SUSPENDED", "payment_failed:2027-02"]);
    assert.equal(await prisma.auditLog.count({ where: { action: "shift.suspended_nonpayment", entityId: shiftId } }), 1);
    assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), SESSIONS);

    // תיעוד התשלום באישור מפורש מסדיר את החוב; חידוש המשמרת הוא החלטה נפרדת
    await assert.rejects(() => life.recordManualPayment({ chargeId: overdue.id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-02-24", confirm: false, now: new Date("2027-02-24T09:00:00Z") }), { code: "INVALID" });
    assert.equal((await chargeOf(shiftId, "2027-02")).status, "FAILED", "בלי אישור מפורש לא מסומן כשולם");
    await life.recordManualPayment({ chargeId: overdue.id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-02-24", reference: "העברה בנקאית", confirm: true, now: new Date("2027-02-24T09:00:00Z") });
    const settled = await chargeOf(shiftId, "2027-02");
    assert.deepEqual([settled.status, settled.graceUntil, settled.failureCode, settled.manualPaidOn], ["PAID", null, null, "2027-02-24"]);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "SUSPENDED");
    await life.resumeShift({ shiftId, adminId: ids.admin, waiveUnpaid: true, now: new Date("2027-02-24T10:00:00Z") });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");
    assert.equal(await prisma.auditLog.count({ where: { action: "shift_charge.manual_payment", entityId: overdue.id } }), 1);
  });

  // ───────────── שער ורגרסיה ─────────────

  test("שער סגור כברירת מחדל: בלי SHIFTS_ENABLED או בלי ספק תקף אין ספק משמרות; mock אינו ספק באתר", () => {
    assert.equal(gate.getShiftsProvider({}), null);
    assert.equal(gate.getShiftsProvider({ SHIFTS_ENABLED: "true" }), null, "דגל פתוח בלי ספק תקף");
    const legacyMock = { PAYMENT_PROVIDER: "mock", PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_MOCK_ENABLED: "true", PAYMENT_MOCK_ALLOW_DEPLOYED: "true", PAYMENT_WEBHOOK_SECRET: SECRET, DATABASE_URL: testUrl };
    assert.equal(gate.getShiftsProvider({ SHIFTS_ENABLED: "true", ...legacyMock } as never), null, "ספק הבדיקות אינו זמין לאתר");
    const grow = { PAYMENT_PROVIDER: "grow", PAYMENT_ENVIRONMENT: "sandbox", GROW_USER_ID: "biz1", GROW_PAGE_CODE: "page1", GROW_SUCCESS_URL: "https://example.com/s", GROW_CANCEL_URL: "https://example.com/c" };
    assert.equal(gate.getShiftsProvider({ SHIFTS_ENABLED: "false", ...grow } as never), null);
    assert.equal(gate.getShiftsProvider({ SHIFTS_ENABLED: "true", ...grow } as never)?.name, "grow");
  });

  test("רגרסיה: הזמנות רגילות, תשלומי הזמנה וביטולים ממשיכים לעבוד; מופע משמרת אינו ניתן לביטול בודד ואינו ניתן לתפיסה", async () => {
    const shiftId = await createOk();
    const occ = await prisma.shiftOccurrence.findFirstOrThrow({ where: { shiftId }, orderBy: { date: "asc" } });
    // מופע המשמרת חוסם את החדר גם להזמנה רגילה ולהחזקה
    await assert.rejects(() => booking.createAppointment({ userId: ids.b, roomKey: "ROOM3", startTime: occ.startTime, endTime: new Date(occ.startTime.getTime() + HOUR), source: "WEB" }), booking.BookingError);
    await assert.rejects(() => booking.createBookingHold({ userId: ids.b, roomKey: "ROOM3", startTime: occ.startTime, endTime: new Date(occ.startTime.getTime() + HOUR), source: "WEB", now: NOW }), booking.BookingError);
    // ביטול בודד נחסם בשני המסלולים (שינוי/ביטול מחייבים אישור מנהל)
    await assert.rejects(() => booking.cancelAppointment(occ.appointmentId!, { id: ids.a, role: "CLIENT" }), /משמרת קבועה/);
    await assert.rejects(() => booking.cancelAppointment(occ.appointmentId!, { id: ids.admin, role: "ADMIN" }), /משמרת קבועה/);
    await assert.rejects(() => payBooking.cancelBooking({ appointmentId: occ.appointmentId!, requester: { id: ids.a, role: "CLIENT" }, provider }), { code: "CONFLICT" });
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: occ.appointmentId! } })).status, "CONFIRMED");

    // הזמנה רגילה בחדר אחר: יצירה וביטול כרגיל
    const regular = await booking.createAppointment({ userId: ids.b, roomKey: "ROOM4", startTime: occ.startTime, endTime: new Date(occ.startTime.getTime() + HOUR), source: "WEB" });
    assert.equal(regular.status, "CONFIRMED");
    assert.equal((await booking.cancelAppointment(regular.id, { id: ids.b, role: "CLIENT" })).status, "CANCELLED");
  });

  test("תצוגת לקוח: מחיר חודשי וסך שלושה חודשים, מועדי שלושת החיובים, מפגשים קרובים, מצב תשלום, וללא נתוני משתמש אחר", async () => {
    await createOk(ids.a);
    await createOk(ids.b, { roomKey: "ROOM4" });
    const mine = await views.getMyShifts({ userId: ids.a, now: NOW });
    assert.equal(mine.shifts.length, 1);
    assert.equal(mine.eligible, true);
    const s = mine.shifts[0];
    assert.deepEqual([s.status, s.usable, s.occurrencePriceAgorot, s.counts.scheduled], ["ACTIVE", true, OCC_FEB, SESSIONS]);
    assert.deepEqual([s.monthlyPriceAgorot, s.totalAgorot, s.makeupOwed], [MONTHLY, 3 * MONTHLY, 0]);
    assert.deepEqual(
      s.months.map((m) => [m.month, m.dueDate, m.count, m.amountAgorot, m.chargeStatus]),
      [["2027-02", "2027-02-15", 4, MONTHLY, "PAID"], ["2027-03", "2027-03-15", 5, MONTHLY, "PENDING"], ["2027-04", "2027-04-15", 4, MONTHLY, "PENDING"]]
    );
    assert.deepEqual(s.nextCharge, { month: "2027-03", dueDate: "2027-03-15", amountAgorot: MONTHLY });
    assert.equal(s.charges.length, 3);
    assert.ok(s.upcoming.length > 0 && s.upcoming.length <= 6);
    assert.ok(!JSON.stringify(mine).includes(ids.b));
    const noPerm = await views.getMyShifts({ userId: ids.noPerm, now: NOW });
    assert.equal(noPerm.eligible, false);
    const admin = await views.listShiftsAdmin({ roomKey: "ROOM4" });
    assert.deepEqual(admin.map((r) => r.user.id), [ids.b]);
    assert.equal(admin[0].unpaidCharges, 0, "חיובים עתידיים אינם חוב");
    assert.equal((await views.listShiftsAdmin({ status: "SUSPENDED" })).length, 0);
    assert.equal((await views.listEligibility(undefined)).length > 0, true);
  });

  // ───────────── תשלום ידני ─────────────

  test("תשלום ידני: אין חיוב אוטומטי, ותשלום מסומן כשולם רק באישור מפורש, בסכום המדויק ובתאריך תקין", async () => {
    const res = await create(ids.c);
    assert.equal(res.status, "ACTIVE");
    const shiftId = res.shiftId;
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.deepEqual([shift.status, shift.createdById], ["ACTIVE", ids.admin]);
    assert.deepEqual((await chargesOf(shiftId)).map((c) => [c.month, c.dueDate, c.amountAgorot, c.status]), [
      ["2027-02", "2027-02-15", MONTHLY, "PENDING"],
      ["2027-03", "2027-03-15", MONTHLY, "PENDING"],
      ["2027-04", "2027-04-15", MONTHLY, "PENDING"],
    ]);

    // הריצה היומית לעולם אינה מחייבת, גם אחרי שמועד החיוב עבר
    await cron(new Date("2027-02-16T05:00:00Z"));
    assert.equal(await prisma.payment.count({ where: { userId: ids.c } }), 0);
    const late = await chargeOf(shiftId, "2027-02");
    assert.deepEqual([late.status, late.failureCode], ["FAILED", "manual_payment_overdue"], "תשלום ידני שלא התקבל במועד הוא חוב (אין חיוב אוטומטי)");
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE", "בתקופת החסד המשמרת פעילה");

    // תיעוד תשלום: הרשאות, אישור מפורש, סכום מדויק, תאריך תקין
    const c1 = await chargeOf(shiftId, "2027-02");
    const base = { chargeId: c1.id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-02-16", reference: "קבלה 17", confirm: true, now: new Date("2027-02-17T09:00:00Z") };
    assert.equal(c1.status, "FAILED");
    await assert.rejects(() => life.recordManualPayment({ ...base, adminId: ids.a }), { code: "FORBIDDEN" });
    await assert.rejects(() => life.recordManualPayment({ ...base, confirm: false }), { code: "INVALID" }, "בלי אישור מפורש");
    await assert.rejects(() => life.recordManualPayment({ ...base, amountAgorot: MONTHLY - 100 }), { code: "INVALID" }, "תשלום חלקי");
    await assert.rejects(() => life.recordManualPayment({ ...base, paidOn: "2027-02-20" }), { code: "INVALID" }, "תאריך עתידי");
    await assert.rejects(() => life.recordManualPayment({ ...base, paidOn: "not-a-date" }), { code: "INVALID" });
    assert.equal((await chargeOf(shiftId, "2027-02")).status, "FAILED", "ניסיונות שנדחו לא שינו כלום");

    await life.recordManualPayment(base);
    const paid = await chargeOf(shiftId, "2027-02");
    assert.deepEqual([paid.status, paid.manualAmountAgorot, paid.manualPaidOn, paid.manualReference, paid.resolvedById, paid.paymentId], ["PAID", MONTHLY, "2027-02-16", "קבלה 17", ids.admin, null]);
    await assert.rejects(() => life.recordManualPayment(base), { code: "CONFLICT" }, "אי אפשר לתעד פעמיים");
    const audit = await prisma.auditLog.findMany({ where: { entityType: "ShiftCharge", entityId: c1.id, action: "shift_charge.manual_payment" } });
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].adminId, audit[0].userId, audit[0].outcome], [ids.admin, ids.c, "ok"]);

    const view = (await views.getMyShifts({ userId: ids.c, now: new Date("2027-02-17T09:00:00Z") })).shifts[0];
    assert.deepEqual(view.months[0].manual, { amountAgorot: MONTHLY, paidOn: "2027-02-16", reference: "קבלה 17" });

    // תיעוד שני החיובים האחרים; בסוף התקופה המשמרת מסתיימת, בלי חיוב רביעי
    for (const month of ["2027-03", "2027-04"]) {
      await life.recordManualPayment({ chargeId: (await chargeOf(shiftId, month)).id, adminId: ids.admin, amountAgorot: MONTHLY, paidOn: "2027-04-16", confirm: true, now: new Date("2027-04-16T09:00:00Z") });
    }
    await cron(new Date("2027-05-20T05:00:00Z"));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ENDED");
    assert.equal((await chargesOf(shiftId)).length, 3);
  });

  test("הזמנה מתוך התאריך הקרוב: לקוח אינו יכול לבטל בעצמו (אין נתיב ביטול ללקוח), והיעדרות אינה משנה חיוב", async () => {
    const shiftId = await createOk();
    // בקשת לקוח היא רק פנייה: המשמרת, החיובים והמפגשים לא משתנים עד החלטת מנהל
    await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL", reason: "לא אוכל להגיע" });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), SESSIONS);
    // מפגש שחלף בלי הגעה אינו משנה את החיוב החודשי הקבוע
    await cron(new Date("2027-03-20T05:00:00Z"));
    assert.equal((await chargeOf(shiftId, "2027-03")).amountAgorot, MONTHLY);
    assert.equal(await prisma.refund.count({}), 0);
  });

});
