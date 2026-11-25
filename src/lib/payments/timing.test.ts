import { test } from "node:test";
import assert from "node:assert/strict";
import { TimingRecorder, timeStep } from "@/lib/payments/timing";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("שלבים נמדדים, שלב חוזר מצטבר, וכותרת Server-Timing בפורמט התקני", async () => {
  const c = clock();
  const r = new TimingRecorder(c.now);
  await r.step("auth", async () => c.advance(12));
  await r.step("make.http", async () => c.advance(300));
  await r.step("make.http", async () => c.advance(100));
  c.advance(5);
  assert.deepEqual(r.list(), [
    { name: "auth", ms: 12 },
    { name: "make.http", ms: 400 },
  ]);
  assert.equal(r.serverTimingHeader(), "auth;dur=12.0, make.http;dur=400.0, total;dur=417.0");
  assert.equal(r.logFields(), "total=417ms auth=12ms make.http=400ms");
});

test("שלב שנכשל עדיין נמדד, והשגיאה עוברת הלאה", async () => {
  const c = clock();
  const r = new TimingRecorder(c.now);
  await assert.rejects(
    r.step("make.http", async () => {
      c.advance(50);
      throw new Error("boom");
    }),
    /boom/
  );
  assert.deepEqual(r.list(), [{ name: "make.http", ms: 50 }]);
});

test("timeStep רושם להקשר הפעיל גם בקוד עמוק ואסינכרוני; מחוץ להקשר רק מריץ", async () => {
  const c = clock();
  const r = new TimingRecorder(c.now);
  const deep = async () => {
    await new Promise((res) => setTimeout(res, 1));
    return timeStep("db.user", async () => {
      c.advance(7);
      return "ok";
    });
  };
  assert.equal(await r.run(deep), "ok");
  assert.deepEqual(r.list(), [{ name: "db.user", ms: 7 }]);
  // בלי הקשר: אין רישום ואין שגיאה
  assert.equal(await timeStep("db.user", async () => 5), 5);
  assert.deepEqual(r.list(), [{ name: "db.user", ms: 7 }]);
});

test("בקשות מקבילות לא מערבבות מדידות", async () => {
  const a = new TimingRecorder();
  const b = new TimingRecorder();
  await Promise.all([a.run(() => timeStep("only.a", async () => 1)), b.run(() => timeStep("only.b", async () => 1))]);
  assert.deepEqual(a.list().map((s) => s.name), ["only.a"]);
  assert.deepEqual(b.list().map((s) => s.name), ["only.b"]);
});

test("רק שמות שלבים קבועים נרשמים: ערך דינמי (מייל, כתובת, רווח, תווים מיוחדים) נזרק", () => {
  const r = new TimingRecorder(() => 0);
  for (const bad of ["user@x.com", "https://x", "a b", "Auth", "x;dur=1", "", "a".repeat(41), "1abc"]) r.add(bad, 1);
  r.add("ok.step_1", 1);
  r.add("neg", -1);
  r.add("nan", Number.NaN);
  assert.deepEqual(r.list(), [{ name: "ok.step_1", ms: 1 }]);
});
