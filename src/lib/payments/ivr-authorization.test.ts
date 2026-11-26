import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient, RoomKey } from "@/generated/prisma/client";

// בדיקות ההרשאה החד-פעמית בטלפון וביצוע פעולה מורשית (אישור מיתרה) מול PostgreSQL מקומי ייעודי. רצות רק כש-
// AUTHZ_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי בשם *_test. דוגמה:
//   AUTHZ_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_authz_test npm test
// אין בטלפון חיוב בכסף: אין כרטיס שמור, והפעולה היחידה היא אישור הזמנה שהיתרה מכסה במלואה.
const testUrl = process.env.AUTHZ_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) throw new Error("AUTHZ_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
}

const SECRET = "ivr-authz-test-secret-0123456789";
const SITE_PASSWORD = "Site-Pass-9xQ!";
const PIN = "4821";
const DAY = 24 * 3600_000;
const MIN = 60_000;

describe("הרשאה חד-פעמית בטלפון וביצוע מורשה (אישור מיתרה)", { skip: !testUrl && "AUTHZ_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let booking: typeof import("@/lib/booking");
  let authz: typeof import("@/lib/payments/authorization");
  let actions: typeof import("@/lib/payments/authorized-actions");
  let pw: typeof import("@/lib/password");
  let MockPaymentProvider: typeof import("@/lib/payments/testing/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;
  let provider: InstanceType<typeof MockPaymentProvider>;
  let mondayMs: number;
  const ids: Record<string, string> = {};

  const slot = (hour: number, minutes = 60) => {
    const startTime = new Date(mondayMs + hour * 3600_000);
    return { startTime, endTime: new Date(startTime.getTime() + minutes * MIN) };
  };

  async function wipe() {
    await prisma.paymentAuthorization.deleteMany({});
    await prisma.creditUsage.deleteMany({});
    await prisma.packageUsage.deleteMany({});
    await prisma.credit.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
    await prisma.hoursPackage.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.debtSettlement.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.mockProviderRecord.deleteMany({});
    await prisma.pinThrottle.deleteMany({});
    await prisma.ivrPinEvent.deleteMany({});
    await prisma.appointment.deleteMany({});
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = await import("@/lib/prisma"));
    booking = await import("@/lib/booking");
    authz = await import("@/lib/payments/authorization");
    actions = await import("@/lib/payments/authorized-actions");
    pw = await import("@/lib/password");
    ({ MockPaymentProvider } = await import("@/lib/payments/testing/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    const { jerusalemParts } = await import("@/lib/opening-hours");

    const d = new Date();
    d.setDate(d.getDate() + 90);
    while (jerusalemParts(d).weekday !== 1) d.setDate(d.getDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    mondayMs = d.getTime();

    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "az " } } });
  });

  beforeEach(async () => {
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "az " } } });
    provider = new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));
    const passwordHash = await pw.hashPassword(SITE_PASSWORD);
    const ivrPinHash = await pw.hashPassword(PIN);
    const mk = async (key: string, extra: Record<string, unknown> = {}) => {
      ids[key] = (
        await prisma.user.create({
          data: {
            name: `az ${key}`,
            email: `az-${key}@test.local`,
            passwordHash,
            gender: "MALE",
            status: "APPROVED",
            ivrPinHash,
            trialDiscountUsedAt: new Date("2020-01-01T00:00:00Z"),
            ...(extra as object),
          } as never,
        })
      ).id;
    };
    await mk("a");
    await mk("b");
    await mk("noPin", { ivrPinHash: null });
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "az " } } });
    await prisma.$disconnect();
  });

  // ───────────── עזרים ─────────────
  const hold = (userId: string, room: RoomKey, hour: number, minutes = 60) =>
    booking.createBookingHold({ userId, roomKey: room, ...slot(hour, minutes), source: "IVR" });
  const seedPackage = (userId: string, minutes: number, expiresAt = new Date(Date.now() + 300 * DAY)) =>
    prisma.hoursPackage.create({ data: { userId, hours: 5, pricePaidAgorot: 30000, minutesTotal: minutes, minutesRemaining: minutes, expiresAt } });
  const remaining = async (userId: string) =>
    (await prisma.hoursPackage.aggregate({ where: { userId }, _sum: { minutesRemaining: true } }))._sum.minutesRemaining ?? 0;
  const apptOf = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });

  async function authorize(userId: string, appointmentId: string, packageMinutes = 60, pin = PIN) {
    const res = await authz.authorizeWithPin({ userId, pin, appointmentId, action: "CONFIRM_BALANCE", amountAgorot: 0, packageMinutes });
    assert.equal(res.status, "OK", JSON.stringify(res));
    return res.status === "OK" ? res.authorizationId : "";
  }
  const run = (authorizationId: string, userId: string, appointmentId: string, extra: Record<string, unknown> = {}) =>
    actions.executeAuthorizedBooking({ authorizationId, userId, appointmentId, provider, ...(extra as object) });

  // ───────────── הרשאה חד-פעמית ─────────────

  test("הרשאה: מונפקת רק אחרי קוד נכון וקשורה לפעולה; קוד שגוי/לא מוגדר/החזקה לא פעילה לא מנפיקים", async () => {
    const h = await hold(ids.a, "ROOM3", 10);
    const bad = await authz.authorizeWithPin({ userId: ids.a, pin: "0000", appointmentId: h.id, action: "CONFIRM_BALANCE", amountAgorot: 0, packageMinutes: 60 });
    assert.deepEqual(bad, { status: "INVALID", attemptsLeft: 4 });
    assert.equal(await prisma.paymentAuthorization.count({}), 0);

    const hn = await hold(ids.noPin, "ROOM4", 10);
    assert.deepEqual(await authz.authorizeWithPin({ userId: ids.noPin, pin: PIN, appointmentId: hn.id, action: "CONFIRM_BALANCE", amountAgorot: 0, packageMinutes: 60 }), { status: "NOT_SET" });

    // הזמנה של אחר / החזקה שפגה: לא נבדק קוד
    assert.deepEqual(await authz.authorizeWithPin({ userId: ids.b, pin: PIN, appointmentId: h.id, action: "CONFIRM_BALANCE", amountAgorot: 0, packageMinutes: 60 }), { status: "HOLD_INACTIVE" });
    const expired = await authz.authorizeWithPin({ userId: ids.a, pin: PIN, appointmentId: h.id, action: "CONFIRM_BALANCE", amountAgorot: 0, packageMinutes: 60, now: new Date(Date.now() + 11 * MIN) });
    assert.deepEqual(expired, { status: "HOLD_INACTIVE" });
    assert.equal((await prisma.pinThrottle.findUnique({ where: { scope_subject: { scope: "VERIFY", subject: ids.b } } })), null, "לא נרשם ניסיון");

    // אישור מיתרה הוא תמיד בלי סכום בכסף ועם דקות; אין פעולת חיוב בכסף בטלפון
    await assert.rejects(() => authz.authorizeWithPin({ userId: ids.a, pin: PIN, appointmentId: h.id, action: "CONFIRM_BALANCE", amountAgorot: 100, packageMinutes: 60 }), RangeError);
    await assert.rejects(() => authz.authorizeWithPin({ userId: ids.a, pin: PIN, appointmentId: h.id, action: "PAY_CARD" as never, amountAgorot: 7500, packageMinutes: 0 }), RangeError);
    assert.equal(await prisma.paymentAuthorization.count({}), 0);

    const ok = await authorize(ids.a, h.id);
    const row = await prisma.paymentAuthorization.findUniqueOrThrow({ where: { id: ok } });
    assert.deepEqual([row.userId, row.appointmentId, row.action, row.amountAgorot, row.packageMinutes, row.consumedAt], [ids.a, h.id, "CONFIRM_BALANCE", 0, 60, null]);
    assert.ok(row.expiresAt.getTime() - row.createdAt.getTime() <= 61_000, "תוקף קצר");
    assert.equal(ok.length, 32);
  });

  test("הרשאה חד-פעמית: נצרכת פעם אחת, רק למשתמש ולהזמנה שלה, לפני פקיעה; הרשאה חדשה מבטלת קודמת", async () => {
    const h = await hold(ids.a, "ROOM3", 10);
    const h2 = await hold(ids.a, "ROOM4", 10);
    const id = await authorize(ids.a, h.id);

    assert.equal(await authz.consumeAuthorization({ id, userId: ids.b, appointmentId: h.id }), null, "משתמש אחר");
    assert.equal(await authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h2.id }), null, "הזמנה אחרת");
    assert.equal(await authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h.id, now: new Date(Date.now() + 61_000) }), null, "פגה");
    assert.equal((await prisma.paymentAuthorization.findUniqueOrThrow({ where: { id } })).consumedAt, null, "ניסיונות כושלים לא שרפו אותה");

    const results = await Promise.all(Array.from({ length: 10 }, () => authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h.id })));
    assert.equal(results.filter(Boolean).length, 1, "בקשות מקבילות: צריכה אחת בלבד");
    assert.equal(await authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h.id }), null, "שימוש חוזר");

    const first = await authorize(ids.a, h2.id);
    const second = await authorize(ids.a, h2.id);
    assert.equal(await authz.consumeAuthorization({ id: first, userId: ids.a, appointmentId: h2.id }), null, "הרשאה קודמת בוטלה");
    assert.ok(await authz.consumeAuthorization({ id: second, userId: ids.a, appointmentId: h2.id }));
  });

  // ───────────── ביצוע: יתרה ─────────────

  test("תשלום מיתרה: מאשר, מנכה פעם אחת, ובקשה חוזרת עם אותה הרשאה לא עושה דבר", async () => {
    await seedPackage(ids.a, 300);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id);

    const res = await run(id, ids.a, h.id);
    assert.deepEqual(res, { status: "CONFIRMED", paidFromBalanceMinutes: 60 });
    const appt = await apptOf(h.id);
    assert.deepEqual([appt.status, appt.paymentStatus, appt.paidFromBalanceMinutes, appt.paidCashAgorot], ["CONFIRMED", "PAID", 60, 0]);
    assert.equal(await remaining(ids.a), 240);
    assert.equal(await prisma.payment.count({}), 0, "אין תשלום בכסף");

    assert.deepEqual(await run(id, ids.a, h.id), { status: "AUTH_INVALID" });
    assert.equal(await remaining(ids.a), 240, "בקשה חוזרת לא ניכתה שוב");
  });

  test("תשלום מיתרה: היתרה השתנתה אחרי ההרשאה -> נדחה בלי ניכוי חלקי; החזקה שפגה -> בלי ניכוי", async () => {
    await seedPackage(ids.a, 60);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id);
    await prisma.hoursPackage.updateMany({ where: { userId: ids.a }, data: { minutesRemaining: 15 } });
    assert.deepEqual(await run(id, ids.a, h.id), { status: "INSUFFICIENT_BALANCE" });
    assert.equal(await remaining(ids.a), 15);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    await prisma.hoursPackage.updateMany({ where: { userId: ids.a }, data: { minutesRemaining: 60 } });
    // ההרשאה בתוקף, אבל ההחזקה פגה (לפי המסד) לפני הביצוע: אין ניכוי
    const id2 = await authorize(ids.a, h.id);
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(await run(id2, ids.a, h.id), { status: "HOLD_EXPIRED" });
    assert.equal(await remaining(ids.a), 60);

    // והרשאה שפגה (60 שניות) נדחית בלי קשר להחזקה
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() + 5 * MIN) } });
    const id3 = await authorize(ids.a, h.id);
    assert.deepEqual(await run(id3, ids.a, h.id, { now: new Date(Date.now() + 2 * MIN) }), { status: "AUTH_INVALID" });
    assert.equal(await remaining(ids.a), 60);
  });

  test("הרשאה לחלוקה שונה ממשך ההזמנה: PLAN_CHANGED בלי ניכוי", async () => {
    await seedPackage(ids.a, 300);
    const h = await hold(ids.a, "ROOM3", 10, 90);
    const id = await authorize(ids.a, h.id, 60);
    assert.deepEqual(await run(id, ids.a, h.id), { status: "PLAN_CHANGED" });
    assert.equal(await remaining(ids.a), 300);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
  });

  test("שתי הזמנות מקבילות על אותה יתרה, בהרשאות נפרדות: רק אחת מנוכה", async () => {
    await seedPackage(ids.a, 60);
    const h1 = await hold(ids.a, "ROOM3", 10);
    const h2 = await hold(ids.a, "ROOM4", 10);
    const [a1, a2] = [await authorize(ids.a, h1.id), await authorize(ids.a, h2.id)];
    const [r1, r2] = await Promise.all([run(a1, ids.a, h1.id), run(a2, ids.a, h2.id)]);
    assert.deepEqual([r1.status, r2.status].sort(), ["CONFIRMED", "INSUFFICIENT_BALANCE"]);
    assert.equal(await remaining(ids.a), 0);
  });

  test("הקוד אינו בלוגים או בתוצאות", async () => {
    const { captureConsole } = await import("@/ivr/test-harness");
    await seedPackage(ids.a, 300);
    const h = await hold(ids.a, "ROOM3", 10);
    const { result, output } = await captureConsole(async () => {
      const out: unknown[] = [];
      out.push(await authz.authorizeWithPin({ userId: ids.a, pin: "0000", appointmentId: h.id, action: "CONFIRM_BALANCE", amountAgorot: 0, packageMinutes: 60 }));
      const id = await authorize(ids.a, h.id);
      out.push(await run(id, ids.a, h.id));
      return out;
    });
    const dump = JSON.stringify(result);
    for (const secret of [PIN, "0000", SITE_PASSWORD]) {
      assert.ok(!dump.includes(secret) && !output.includes(secret), `נחשף ${secret}`);
    }
  });
});
