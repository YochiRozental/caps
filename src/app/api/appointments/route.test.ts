import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

/**
 * רגרסיה: POST /api/appointments (הזמנה ישירה, ללא החזקה ותשלום) חייב להיחסם עם PAYMENT_REQUIRED כשזרימת התשלום
 * מחויבת. מדמים את ההתחברות, המסד, הספק ויצירת ההזמנה, כדי לבדוק את הנתיב עצמו בלי DB (דורש --experimental-test-module-mocks).
 */

let provider: { name: string } | null = null;
let session: { user: { id: string; role: string } } | null = { user: { id: "u1", role: "CLIENT" } };
let created = 0;
const USER = { id: "u1", role: "CLIENT", email: "a@b.c", status: "APPROVED" };

class FakeBookingError extends Error {}

mock.module("@/auth", { namedExports: { auth: async () => session } });
mock.module("@/lib/prisma", { namedExports: { prisma: { user: { findUnique: async () => USER } } } });
mock.module("@/lib/payments/runtime", { namedExports: { getRuntimeProvider: () => provider } });
mock.module("@/lib/booking", {
  namedExports: {
    BookingError: FakeBookingError,
    createAppointment: async () => {
      created++;
      return { id: "a1" };
    },
  },
});

const ENV_KEYS = ["PAYMENT_PROVIDER", "PAYMENT_MOCK_OPEN_TO_ALL", "PAYMENT_MOCK_ALLOW_DEPLOYED", "PAYMENT_MOCK_TEST_USERS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  provider = null;
  session = { user: { id: "u1", role: "CLIENT" } };
  created = 0;
  for (const k of ENV_KEYS) delete process.env[k];
});
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function post() {
  const { POST } = await import("@/app/api/appointments/route");
  const res = await POST(
    new Request("http://localhost/api/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomKey: "ROOM1", startTime: "2030-01-01T10:00:00Z" }),
    })
  );
  return { status: res.status, body: (await res.json()) as { code?: string } };
}

test("זרימת התשלום מחויבת (ספק פעיל): הזמנה ישירה נחסמת ב-409 PAYMENT_REQUIRED ולא נוצרת", async () => {
  provider = { name: "make-grow" };
  const r = await post();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PAYMENT_REQUIRED");
  assert.equal(created, 0);
});

test("גם ספק grow ו-mock (לא מוגבל) חוסמים הזמנה ישירה", async () => {
  for (const name of ["grow", "mock"]) {
    provider = { name };
    const r = await post();
    assert.equal(r.status, 409, name);
    assert.equal(r.body.code, "PAYMENT_REQUIRED");
  }
  assert.equal(created, 0);
});

test("אתר מותקן עם Mock מוגבל: משתמש שאינו משתמש בדיקה ממשיך בהזמנה הקיימת (לא נחסם)", async () => {
  provider = { name: "mock" };
  process.env.PAYMENT_PROVIDER = "mock";
  process.env.PAYMENT_MOCK_ALLOW_DEPLOYED = "true";
  process.env.PAYMENT_MOCK_TEST_USERS = "someone-else@example.com";
  const r = await post();
  assert.notEqual(r.body.code, "PAYMENT_REQUIRED");
});

test("בלי ספק מוגדר: ההתנהגות הקיימת, ללא חסימה", async () => {
  provider = null;
  const r = await post();
  assert.notEqual(r.body.code, "PAYMENT_REQUIRED");
});

test("לא מחובר: 401 לפני כל דבר אחר", async () => {
  provider = { name: "make-grow" };
  session = null;
  assert.equal((await post()).status, 401);
});

test("ספק make מוגדר אך התצורה שבורה (ספק=null): הזמנה ישירה נחסמת ב-503 PAYMENT_UNAVAILABLE ולא נוצרת (כשל סגור)", async () => {
  provider = null;
  process.env.PAYMENT_PROVIDER = "make";
  const r = await post();
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "PAYMENT_UNAVAILABLE");
  assert.equal(created, 0);
});

test("בלי ספק מוגדר כלל (none/ריק): ההזמנה הרגילה ממשיכה כרגיל", async () => {
  provider = null;
  const r = await post();
  assert.notEqual(r.status, 503);
});
