import { after, before, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider } from "@/lib/payments/provider";
import type { Method, RunningApp } from "@/ivr/test-harness";

// ספק הבדיקות אינו זמין לאתר (אין PAYMENT_PROVIDER=mock): מזריקים אותו במקום ספק הזמן-ריצה, רק בתהליך הבדיקה.
// null = אין ספק תקף (כמו סביבה בלי PAYMENT_PROVIDER)
let testProvider: PaymentProvider | null = null;
mock.module("@/lib/payments/runtime", { namedExports: { getRuntimeProvider: () => testProvider } });

// בדיקות מקצה לקצה של הזמנה בטלפון מיתרת שעות: נתב ימות המשיח האמיתי, מטפלי השיחה האמיתיים, שירותי שלבים C+D+F.2, ספק
// הבדיקות על PostgreSQL מקומי ייעודי, בבקשות HTTP אמיתיות. רצות רק כש-IVRPAY_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי
// בשם *_test. דוגמה:
//   IVRPAY_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_ivrpay_test npm test
const testUrl = process.env.IVRPAY_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    parsed.hostname,
  );
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test"))
    throw new Error(
      "IVRPAY_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test",
    );
}

const IVR_SECRET = "ivr-pay-test-secret";
const SITE_PASSWORD = "Site-Pass-9xQ!";
const PIN = "4821";
const WRONG_PIN = "0000";
const PHONES = {
  u1: "0501110031",
  u2: "0501110032",
  noPin: "0501110033",
  fresh: "0501110034",
};
const DAY = 24 * 3600_000;

const ENV_KEYS = [
  "IVR_PAYMENTS_ENABLED",
  "IVR_PAYMENT_STEP_TIMEOUT_MS",
] as const;

describe(
  "הזמנה ותשלום בטלפון: IVR אמיתי מקצה לקצה (Mock)",
  { skip: !testUrl && "IVRPAY_TEST_DATABASE_URL לא מוגדר" },
  () => {
    let prisma: PrismaClient;
    let app: RunningApp;
    let h: typeof import("@/ivr/test-harness");
    let MockPaymentProvider: typeof import("@/lib/payments/testing/mock-provider").MockPaymentProvider;
    let mondayLocal: Date;
    const ids: Record<string, string> = {};
    const savedEnv: Record<string, string | undefined> = {};

    const path = (name: string) => `/${name}-${IVR_SECRET}`;
    let counter = 0;
    const newCallId = () => `pay-${Date.now()}-${counter++}`;
    const base = (
      callId: string,
      phone: string,
      ext = "9/1",
    ): [string, string][] => [
      ["ApiPhone", phone],
      ["ApiDID", "035551234"],
      ["ApiExtension", ext],
      ["ApiCallId", callId],
    ];
    const ddmm = (d: Date) =>
      `${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`;

    /** שיחה אחת כמו ימות המשיח: קלטים מצטברים, ואפשרות לשלוח כל הקשה בשיטה/פרמטרים אחרים */
    class Session {
      vals: [string, string][] = [];
      replies: string[] = [];
      constructor(
        readonly phone: string,
        readonly method: Method = "POST",
        readonly callId = newCallId(),
      ) {}
      get last() {
        return this.replies.at(-1) ?? "";
      }
      async start() {
        const r = await h.send(
          app.base,
          path("booking"),
          this.method,
          base(this.callId, this.phone),
        );
        this.replies.push(r.text);
        return r.text;
      }
      async answer(
        value: string,
        opts: {
          method?: Method;
          extraQuery?: [string, string][];
          asQueryOnly?: boolean;
        } = {},
      ) {
        const name = h.nextValName(this.last)!;
        assert.ok(name, "אין בקשת קלט פתוחה: " + this.last);
        const method = opts.method ?? this.method;
        const pairs: [string, string][] = [
          ...base(this.callId, this.phone),
          ...this.vals,
          ...(opts.asQueryOnly ? [] : [[name, value] as [string, string]]),
        ];
        const extraQuery = opts.asQueryOnly
          ? [[name, value] as [string, string]]
          : opts.extraQuery;
        const r = await h.send(app.base, path("booking"), method, pairs, {
          extraQuery,
        });
        this.replies.push(r.text);
        if (!opts.asQueryOnly && r.text.startsWith("read="))
          this.vals.push([name, value]);
        else if (!opts.asQueryOnly) this.vals.push([name, value]);
        return r.text;
      }
      async hangup() {
        const r = await h.send(app.base, path("booking"), this.method, [
          ...base(this.callId, this.phone),
          ...this.vals,
          ["hangup", "yes"],
        ]);
        return r.status;
      }
      /** פרטי ההזמנה עד הצגת תפריט התשלום */
      async toMenu(opts: { room?: string; hhmm?: string; date?: Date } = {}) {
        await this.start();
        await this.answer(opts.room ?? "5");
        await this.answer("4");
        await this.answer(ddmm(opts.date ?? mondayLocal));
        await this.answer(opts.hhmm ?? "1200");
        return this.answer("4"); // משך: שעה
      }
      async toPinPrompt(opts: Parameters<Session["toMenu"]>[0] = {}) {
        await this.toMenu(opts);
        return this.answer("1");
      }
    }

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

    const seedPackage = (userId: string, minutes: number) =>
      prisma.hoursPackage.create({
        data: {
          userId,
          hours: 5,
          pricePaidAgorot: 30000,
          minutesTotal: minutes,
          minutesRemaining: minutes,
          expiresAt: new Date(Date.now() + 300 * DAY),
        },
      });
    const remaining = async (userId: string) =>
      (
        await prisma.hoursPackage.aggregate({
          where: { userId },
          _sum: { minutesRemaining: true },
        })
      )._sum.minutesRemaining ?? 0;
    const counts = async () => ({
      confirmed: await prisma.appointment.count({
        where: { status: "CONFIRMED" },
      }),
      holds: await prisma.appointment.count({
        where: { status: "PENDING_PAYMENT" },
      }),
      payments: await prisma.payment.count({}),
      succeeded: await prisma.payment.count({ where: { status: "SUCCEEDED" } }),
      providerPays: await prisma.mockProviderRecord.count({
        where: { key: { startsWith: "pay:" } },
      }),
      auths: await prisma.paymentAuthorization.count({}),
      throttles: await prisma.pinThrottle.count({}),
      debts: await prisma.debt.count({}),
    });
    async function waitFor(check: () => Promise<boolean>, ms = 4000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await check()) return true;
        await h.sleep(60);
      }
      return check();
    }

    before(async () => {
      assertLocalTestDatabase(testUrl!);
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
      process.env.DATABASE_URL = testUrl;
      process.env.IVR_PAYMENTS_ENABLED = "true";
      delete process.env.IVR_PAYMENT_STEP_TIMEOUT_MS;

      h = await import("@/ivr/test-harness");
      ({ prisma } = await import("@/lib/prisma"));
      ({ MockPaymentProvider } = await import("@/lib/payments/testing/mock-provider"));
      const { PrismaMockStore } = await import("@/lib/payments/mock-store");
      testProvider = new MockPaymentProvider("ivr-pay-test-webhook-secret-01234", new PrismaMockStore(prisma));
      const { hashPassword } = await import("@/lib/password");
      const { createIvrApp } = await import("@/ivr/app");
      const flow = await import("@/ivr/booking-flow");
      app = await h.startApp(
        createIvrApp({
          secret: IVR_SECRET,
          handlers: {
            check: flow.handleCheckCall,
            members: flow.handleMembersCall,
            notRegistered: flow.handleNotRegisteredCall,
          },
        }),
      );

      const d = new Date();
      d.setDate(d.getDate() + 60);
      while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      mondayLocal = d;

      await wipe();
      await prisma.user.deleteMany({
        where: { phone: { in: Object.values(PHONES) } },
      });
      const passwordHash = await hashPassword(SITE_PASSWORD);
      const ivrPinHash = await hashPassword(PIN);
      const mk = async (
        key: keyof typeof PHONES,
        extra: Record<string, unknown>,
      ) => {
        ids[key] = (
          await prisma.user.create({
            data: {
              name: `ivrpay ${key}`,
              email: `ivrpay-${key}@test.local`,
              phone: PHONES[key],
              passwordHash,
              gender: "MALE",
              status: "APPROVED",
              ...(extra as object),
            } as never,
          })
        ).id;
      };
      await mk("u1", { ivrPinHash });
      await mk("u2", { ivrPinHash });
      await mk("noPin", {});
      // "כבר ניצלו" את הנחת ההזמנה הראשונה (לא קשורה לקובץ הזה), כדי שבדיקות המחיר כאן ימשיכו לבדוק מחיר מלא
      await markTrialDiscountUsed(Object.values(ids));
    });

    function markTrialDiscountUsed(userIds: string[]) {
      return prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: {
          trialDiscountUsedAt: new Date("2020-01-01T00:00:00Z"),
          trialDiscountReservedAppointmentId: null,
        },
      });
    }

    beforeEach(async () => {
      await wipe();
      await markTrialDiscountUsed(Object.values(ids));
      process.env.IVR_PAYMENTS_ENABLED = "true";
      delete process.env.IVR_PAYMENT_STEP_TIMEOUT_MS;
    });

    after(async () => {
      if (prisma) {
        await wipe();
        await prisma.user.deleteMany({
          where: { phone: { in: Object.values(PHONES) } },
        });
        await prisma.$disconnect();
      }
      await app?.close();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    // ───────────── הצלחות ─────────────

    test("הזמנה מלאה מחבילה: החזקה, תפריט מחיר ויתרה, קוד ב-POST, ניכוי ואישור; ללא תשלום בכסף", async () => {
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1);
      const menu = await s.toMenu();
      assert.match(menu, /מכסה את כל ההזמנה/);
      assert.match(menu, /75 שקלים/);
      assert.match(menu, /עשר דקות/);
      assert.equal((await counts()).holds, 1, "נוצרה החזקה לפני התשלום");
      assert.equal(await remaining(ids.u1), 300, "אין ניכוי עד האישור");

      assert.match(await s.answer("1"), /הקישו את הקוד הטלפוני/);
      const final = await s.answer(PIN);
      assert.match(final, /ההזמנה אושרה/);
      assert.match(final, /נוצלו שעה מהיתרה/);

      const appt = await prisma.appointment.findFirstOrThrow({
        where: { status: "CONFIRMED" },
      });
      assert.deepEqual(
        [
          appt.source,
          appt.paymentStatus,
          appt.paidFromBalanceMinutes,
          appt.paidCashAgorot,
          appt.holdExpiresAt,
          appt.userId,
        ],
        ["IVR", "PAID", 60, 0, null, ids.u1],
      );
      assert.equal(await remaining(ids.u1), 240);
      const c = await counts();
      assert.deepEqual([c.payments, c.holds, c.debts], [0, 0, 0]);
      assert.equal(
        await prisma.paymentAuthorization.count({
          where: { consumedAt: null },
        }),
        0,
        "ההרשאה נוצלה",
      );
      assert.equal(
        (
          await prisma.pinThrottle.findFirst({
            where: { scope: "VERIFY", subject: ids.u1 },
          })
        )?.failedCount ?? 0,
        0,
      );
    });

    // ───────────── חסימות ──────────────

    test("לקוח ללא יתרה מספקת: מופנה לאתר (אין חיוב בכסף בטלפון), ללא אישור, חוב או חיוב, וההחזקה משוחררת", async () => {
      for (const minutes of [0, 30]) {
        await wipe();
        if (minutes) await seedPackage(ids.u1, minutes);
        const s = new Session(PHONES.u1);
        await s.toMenu().catch(() => undefined);
        assert.match(s.last, /אין לך יתרת שעות מספיקה/, `יתרה ${minutes}`);
        assert.match(s.last, /היכנסו לאתר/);
        const c = await counts();
        assert.deepEqual(
          [c.confirmed, c.holds, c.payments, c.debts, c.auths, c.providerPays],
          [0, 0, 0, 0, 0, 0],
          `יתרה ${minutes}`,
        );
      }
    });

    test("לקוח ללא קוד טלפוני: לא ניתן לאשר פעולה כספית, ההחזקה משוחררת", async () => {
      await seedPackage(ids.noPin, 300);
      const s = new Session(PHONES.noPin);
      await s.toMenu().catch(() => undefined);
      assert.match(s.last, /לא הוגדר לך קוד טלפוני/);
      const c = await counts();
      assert.deepEqual([c.confirmed, c.holds, c.payments], [0, 0, 0]);
      assert.equal(await remaining(ids.noPin), 300);
    });

    test("קוד שגוי: ניסיונות נספרים בין שיחות, חסימה אחרי 5, וקוד נכון בזמן חסימה אינו מתקבל", async () => {
      await seedPackage(ids.u1, 300);
      const s1 = new Session(PHONES.u1);
      await s1.toPinPrompt();
      assert.match(await s1.answer(WRONG_PIN), /הקוד שגוי, נותרו 4 ניסיונות/);
      assert.match(await s1.answer(WRONG_PIN), /נותרו 3 ניסיונות/);
      assert.match(
        await s1.answer(WRONG_PIN),
        /לא התקבל קוד תקין/,
        "אחרי 3 הקשות השיחה מסתיימת",
      );
      assert.deepEqual(
        [(await counts()).confirmed, (await counts()).holds],
        [0, 0],
      );

      const s2 = new Session(PHONES.u1);
      await s2.toPinPrompt({ hhmm: "1300" });
      assert.match(await s2.answer(WRONG_PIN), /נותרו 1 ניסיונות/);
      assert.match(
        await s2.answer(WRONG_PIN),
        /נחסם זמנית/,
        "הניסיון החמישי חוסם",
      );

      const s3 = new Session(PHONES.u1);
      await s3.toPinPrompt({ hhmm: "1400" });
      assert.match(
        await s3.answer(PIN),
        /נחסם זמנית/,
        "קוד נכון בזמן חסימה לא עוקף",
      );
      const c = await counts();
      assert.deepEqual(
        [c.confirmed, c.holds, c.payments, c.auths],
        [0, 0, 0, 0],
      );
      assert.equal(await remaining(ids.u1), 300);
      // חסימה של משתמש אחד לא חוסמת אחר
      await seedPackage(ids.u2, 300);
      const other = new Session(PHONES.u2);
      await other.toPinPrompt({ hhmm: "1500" });
      assert.match(await other.answer(PIN), /ההזמנה אושרה/);
    });

    // ───────────── אבטחת תעבורת הקוד ─────────────

    test("תשלום דרך GET: לא מבקשים קוד, לא נבדק אימות, ההחזקה משוחררת", async () => {
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1, "GET");
      await s.toMenu().catch(() => undefined);
      assert.match(s.last, /אימות בקוד אינו זמין/);
      assert.ok(
        !s.replies.some((r) => /הקישו את הקוד/.test(r)),
        "הקוד לא התבקש בכלל",
      );
      const c = await counts();
      assert.deepEqual(
        [c.confirmed, c.holds, c.payments, c.throttles, c.auths],
        [0, 0, 0, 0, 0],
      );
      assert.equal(await remaining(ids.u1), 300);
    });

    test("הקשת קוד שהגיעה ב-GET באמצע שיחת POST: נדחית בלי אימות ובלי ספירת ניסיון", async () => {
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1, "POST");
      await s.toPinPrompt();
      assert.match(
        await s.answer(PIN, { method: "GET" }),
        /אימות בקוד אינו זמין/,
      );
      const c = await counts();
      assert.deepEqual(
        [c.confirmed, c.holds, c.throttles, c.auths],
        [0, 0, 0, 0],
        "הקוד לא נבדק",
      );
      assert.equal(await remaining(ids.u1), 300);
    });

    test("קוד ב-query של POST: בגוף ריק מתעלמים (ממשיכים להמתין), ועם query לצד הגוף נדחה בלי אימות", async () => {
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1);
      await s.toPinPrompt();
      // הקוד רק ב-query: הספרייה קוראת את גוף ה-POST בלבד, ולכן אין קלט ופרומפט הקוד נשלח שוב
      const again = await s.answer(PIN, { asQueryOnly: true });
      assert.match(again, /^read=.*הקוד הטלפוני/);
      assert.deepEqual(
        [
          (await counts()).throttles,
          (await counts()).auths,
          (await counts()).confirmed,
        ],
        [0, 0, 0],
      );
      // עדיין ממתינה: הקשה תקינה בגוף משלימה את ההזמנה
      assert.match(await s.answer(PIN), /ההזמנה אושרה/);

      await wipe();
      await seedPackage(ids.u1, 300);
      const t = new Session(PHONES.u1);
      await t.toPinPrompt({ hhmm: "1300" });
      const name = h.nextValName(t.last)!;
      assert.match(
        await t.answer(PIN, { extraQuery: [[name, PIN]] }),
        /אימות בקוד אינו זמין/,
      );
      const c = await counts();
      assert.deepEqual(
        [c.throttles, c.auths, c.confirmed, c.holds],
        [0, 0, 0, 0],
      );
    });

    // ───────────── החזקה, ניתוק ו-timeout ─────────────

    test("החזקה שפגה לפני האישור ובזמן הקשת הקוד: לא נבדק קוד, לא מנוכה ולא מחויב", async () => {
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1);
      await s.toMenu();
      await prisma.appointment.updateMany({
        where: { status: "PENDING_PAYMENT" },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });
      assert.match(await s.answer("1"), /הזמן להשלמת ההזמנה הסתיים/);
      assert.ok(!s.replies.some((r) => /הקישו את הקוד/.test(r)));
      assert.equal((await counts()).throttles, 0);

      await wipe();
      await seedPackage(ids.u1, 300);
      const t = new Session(PHONES.u1);
      await t.toPinPrompt({ hhmm: "1300" });
      await prisma.appointment.updateMany({
        where: { status: "PENDING_PAYMENT" },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });
      assert.match(await t.answer(PIN), /הזמן להשלמת ההזמנה הסתיים/);
      const c = await counts();
      assert.deepEqual(
        [c.confirmed, c.payments, c.throttles, c.auths],
        [0, 0, 0, 0],
        "הקוד לא נבדק אחרי פקיעה",
      );
      assert.equal(await remaining(ids.u1), 300);
      // והחדר פנוי לאחרים (החזקה שפגה לא חוסמת)
      await seedPackage(ids.u2, 300);
      const u = new Session(PHONES.u2);
      await u.toPinPrompt({ hhmm: "1300" });
      assert.match(await u.answer(PIN), /ההזמנה אושרה/);
    });

    test("ניתוק בתפריט ובהקשת הקוד משחרר את ההחזקה בלי חיוב", async () => {
      await seedPackage(ids.u1, 300);
      const a = new Session(PHONES.u1);
      await a.toMenu();
      assert.equal((await counts()).holds, 1);
      assert.equal(await a.hangup(), 200);
      assert.ok(
        await waitFor(async () => (await counts()).holds === 0),
        "ההחזקה שוחררה",
      );

      const b = new Session(PHONES.u1);
      await b.toPinPrompt({ hhmm: "1300" });
      assert.equal((await counts()).holds, 1);
      assert.equal(await b.hangup(), 200);
      assert.ok(await waitFor(async () => (await counts()).holds === 0));
      const c = await counts();
      assert.deepEqual([c.confirmed, c.payments, c.throttles], [0, 0, 0]);
      assert.equal(await remaining(ids.u1), 300);
    });

    test("שיחה נטושה (timeout) משחררת את ההחזקה", async () => {
      process.env.IVR_PAYMENT_STEP_TIMEOUT_MS = "300";
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1);
      await s.toMenu();
      assert.equal((await counts()).holds, 1);
      assert.ok(
        await waitFor(async () => (await counts()).holds === 0, 4000),
        "ההחזקה שוחררה אחרי ה-timeout",
      );
      assert.deepEqual(
        [(await counts()).confirmed, (await counts()).payments],
        [0, 0],
      );
    });

    // ───────────── כפילויות ומקביליות ─────────────

    test("בקשה חוזרת אחרי אישור מיתרה (אותה שיחה, אותו קלט): אין ניכוי כפול ואין הזמנה כפולה", async () => {
      await seedPackage(ids.u1, 300);
      const s = new Session(PHONES.u1);
      await s.toPinPrompt();
      assert.match(await s.answer(PIN), /ההזמנה אושרה/);
      assert.equal(await remaining(ids.u1), 240);

      // הלקוח (או הרשת) שולח שוב את אותה בקשה/אותה שיחה מההתחלה, עם אותו קוד
      const again = new Session(PHONES.u1, "POST", s.callId);
      await again.toMenu().catch(() => undefined);
      assert.match(again.last, /תפוס/, "החדר כבר תפוס על ידי ההזמנה שאושרה");
      const c = await counts();
      assert.deepEqual(
        [c.confirmed, c.payments, c.providerPays, c.holds],
        [1, 0, 0, 0],
      );
      assert.equal(await remaining(ids.u1), 240, "לא נוכה שוב");
    });

    test("שתי שיחות מקבילות לאותו חדר ושעה: החזקה אחת מנצחת, אחת מאושרת בלבד, השנייה מקבלת 'תפוס'", async () => {
      await seedPackage(ids.u1, 300);
      await seedPackage(ids.u2, 300);
      const [a, b] = [new Session(PHONES.u1), new Session(PHONES.u2)];
      await Promise.all([
        a.toMenu().catch(() => undefined),
        b.toMenu().catch(() => undefined),
      ]);
      const taken = [a, b].filter((s) => /תפוס/.test(s.last));
      assert.equal(taken.length, 1);
      const winner = [a, b].find((s) => !taken.includes(s))!;
      await winner.answer("1");
      assert.match(await winner.answer(PIN), /ההזמנה אושרה/);
      const c = await counts();
      assert.deepEqual([c.confirmed, c.holds], [1, 0]);
      assert.equal(
        (await remaining(ids.u1)) + (await remaining(ids.u2)),
        300 + 240,
      );
    });

    test("שתי שיחות מקבילות של אותו לקוח על אותה יתרה (שני חדרים): רק אחת מנוכה, השנייה נדחית בלי ניכוי חלקי", async () => {
      await seedPackage(ids.u1, 60);
      const [a, b] = [new Session(PHONES.u1), new Session(PHONES.u1)];
      await Promise.all([
        a.toPinPrompt({ room: "5" }),
        b.toPinPrompt({ room: "6" }),
      ]);
      const [fa, fb] = await Promise.all([a.answer(PIN), b.answer(PIN)]);
      const outcomes = [fa, fb].map((t) =>
        /ההזמנה אושרה/.test(t)
          ? "ok"
          : /יתרת השעות השתנתה ואינה מספיקה/.test(t)
            ? "insufficient"
            : t,
      );
      assert.deepEqual(outcomes.sort(), ["insufficient", "ok"]);
      assert.equal(await remaining(ids.u1), 0);
      const c = await counts();
      assert.deepEqual([c.confirmed, c.holds, c.payments], [1, 0, 0]);
    });

    test("שינוי יתרה במהלך השיחה: אזלה לפני הקוד: אין ניכוי, אין חיוב", async () => {
      await seedPackage(ids.u1, 60);
      const s = new Session(PHONES.u1);
      await s.toPinPrompt();
      await prisma.hoursPackage.updateMany({
        where: { userId: ids.u1 },
        data: { minutesRemaining: 0 },
      });
      assert.match(await s.answer(PIN), /יתרת השעות השתנתה ואינה מספיקה/);
      assert.deepEqual(
        [(await counts()).confirmed, (await counts()).holds],
        [0, 0],
      );

      const c = await counts();
      assert.deepEqual([c.payments, c.providerPays], [0, 0], "לא חויב");
    });

    // ───────────── כשלי ספק ─────────────

    // ───────────── תאימות ולוגים ─────────────

    test("שער סגור: ה-IVR פועל בדיוק כמו קודם (אישור מיד אחרי 'לאישור הקישו 1', בלי החזקה, קוד או תשלום)", async () => {
      const savedProvider = testProvider;
      for (const mode of ["flag-off", "no-provider"] as const) {
        await wipe();
        if (mode === "flag-off") delete process.env.IVR_PAYMENTS_ENABLED;
        else testProvider = null;
        try {
          await seedPackage(ids.u1, 300);
          const s = new Session(PHONES.u1);
          const confirmPrompt = await s.toMenu();
          assert.match(
            confirmPrompt,
            /נקבעה הזמנה/,
            `${mode}: הודעת האישור הקיימת`,
          );
          assert.equal((await counts()).holds, 0, `${mode}: אין החזקה`);
          await s.answer("1");
          const appt = await prisma.appointment.findFirstOrThrow({});
          assert.deepEqual(
            [appt.status, appt.source, appt.paymentStatus, appt.holdExpiresAt],
            ["CONFIRMED", "IVR", "NOT_REQUIRED", null],
            mode,
          );
          const c = await counts();
          assert.deepEqual([c.payments, c.auths, c.throttles], [0, 0, 0], mode);
          assert.equal(await remaining(ids.u1), 300, `${mode}: היתרה לא נגעה`);
        } finally {
          process.env.IVR_PAYMENTS_ENABLED = "true";
          testProvider = savedProvider;
        }
      }
    });

    test("תפריטים 9, 9/1 ו-9/2 ממשיכים לעבוד כשהשער פתוח, בשתי השיטות", async () => {
      for (const method of ["GET", "POST"] as Method[]) {
        const check = await h.send(
          app.base,
          path("check"),
          method,
          base(newCallId(), PHONES.u1, "9"),
        );
        assert.equal(check.text, "go_to_folder=/9/1", method);
        const unknown = await h.send(
          app.base,
          path("check"),
          method,
          base(newCallId(), "0509990000", "9"),
        );
        assert.equal(unknown.text, "go_to_folder=/9/2", method);
        const callId = newCallId();
        const menu = await h.send(
          app.base,
          path("not-registered"),
          method,
          base(callId, "0509990000", "9/2"),
        );
        const explain = await h.send(app.base, path("not-registered"), method, [
          ...base(callId, "0509990000", "9/2"),
          [h.nextValName(menu.text)!, "2"],
        ]);
        assert.equal(explain.text, "go_to_folder=/9/3", method);
      }
    });

    test("הרשמה טלפונית כשהשער פתוח: הקוד נשמר ב-ivrPinHash בלבד, והמשתמש החדש ממתין לאישור (לא יכול לשלם)", async () => {
      await prisma.user.deleteMany({ where: { phone: PHONES.fresh } });
      const s = new Session(PHONES.fresh);
      await h.send(
        app.base,
        path("not-registered"),
        "POST",
        base(s.callId, PHONES.fresh, "9/2"),
      );
      const vals: [string, string][] = [];
      let last = (
        await h.send(
          app.base,
          path("not-registered"),
          "POST",
          base(s.callId, PHONES.fresh, "9/2"),
        )
      ).text;
      for (const answer of ["1", "דני לוי", "7391", "7391"]) {
        const name = h.nextValName(last);
        if (!name) break;
        vals.push([name, answer]);
        last = (
          await h.send(app.base, path("not-registered"), "POST", [
            ...base(s.callId, PHONES.fresh, "9/2"),
            ...vals,
          ])
        ).text;
      }
      const user = await prisma.user.findFirstOrThrow({
        where: { phone: PHONES.fresh },
      });
      assert.equal(user.status, "PENDING");
      assert.ok(user.ivrPinHash);
      const { verifyPassword } = await import("@/lib/password");
      assert.equal(await verifyPassword("7391", user.ivrPinHash!), true);
      assert.equal(
        await verifyPassword("7391", user.passwordHash),
        false,
        "הקוד אינו סיסמת אתר",
      );
      // משתמש ממתין לא מגיע לשיחת ההזמנה בכלל
      const blocked = await h.send(
        app.base,
        path("booking"),
        "POST",
        base(newCallId(), PHONES.fresh),
      );
      assert.match(blocked.text, /^id_list_message=/);
      await prisma.user.delete({ where: { id: user.id } });
    });

    test("הקוד והטלפון אינם מופיעים בלוגים בזרימות מוצלחות, שגויות וחסומות", async () => {
      await seedPackage(ids.u1, 300);
      const { output } = await h.captureConsole(async () => {
        const ok = new Session(PHONES.u1);
        await ok.toPinPrompt();
        await ok.answer(PIN);
        await wipe();
        await seedPackage(ids.u1, 300);
        const bad = new Session(PHONES.u1);
        await bad.toPinPrompt({ hhmm: "1300" });
        await bad.answer(WRONG_PIN);
        await bad.answer(WRONG_PIN);
        const viaGet = new Session(PHONES.u1, "GET");
        await viaGet.toMenu({ hhmm: "1400" }).catch(() => undefined);
      });
      assert.ok(output.includes("[ivr] new call"));
      for (const secret of [
        PIN,
        WRONG_PIN,
        PHONES.u1.slice(1),
        SITE_PASSWORD,
        IVR_SECRET,
      ]) {
        assert.ok(
          !output.includes(secret),
          `הלוג כולל "${secret}":\n${output}`,
        );
      }
    });
  },
);
