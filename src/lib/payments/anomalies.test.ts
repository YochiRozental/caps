import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { ALERT_RETRY_MS, alertAnomaly, anomalyFingerprint, recordPaymentAnomaly } from "@/lib/payments/anomalies";
import { decidePackageVerification } from "@/lib/payments/packages";

/** חריגות תשלום (תיעוד + התראה) והחלטת ההפעלה של רכישת חבילה, בלי מסד: מסד מדומה בזיכרון */

// ───── החלטת ההפעלה ─────

const ok = (amountAgorot = 30000, paid = 1) => ({
  status: "SUCCEEDED" as const,
  amountAgorot,
  paidTransactions: Array.from({ length: paid }, (_, i) => ({ transactionId: `T${i}`, amountAgorot })),
});
const pending = { status: "PENDING" as const, amountAgorot: 30000 };

test("החלטה: רכישה ממתינה ששולמה בסכום הנכון מופעלת; חיוב מרובה מופעל פעם אחת ומסומן", () => {
  assert.deepEqual(decidePackageVerification("PENDING", 30000, ok()), { action: "ACTIVATE", multiplePaid: false });
  assert.deepEqual(decidePackageVerification("PENDING", 30000, ok(30000, 2)), { action: "ACTIVATE", multiplePaid: true });
  // ספק שאינו מדווח paidTransactions נחשב כעסקה אחת
  assert.deepEqual(decidePackageVerification("PENDING", 30000, { status: "SUCCEEDED", amountAgorot: 30000 }), { action: "ACTIVATE", multiplePaid: false });
});

test("החלטה: סכום שגוי לעולם אינו מופעל", () => {
  assert.deepEqual(decidePackageVerification("PENDING", 30000, ok(25000)), { action: "RETURN", outcome: "AMOUNT_MISMATCH" });
  assert.deepEqual(decidePackageVerification("FAILED", 30000, ok(25000)), { action: "RETURN", outcome: "AMOUNT_MISMATCH" });
});

test("החלטה: רכישה שבוטלה לעולם אינה מופעלת אוטומטית; אם שולמה - חריגה לטיפול (גם בסכום שגוי)", () => {
  assert.deepEqual(decidePackageVerification("CANCELLED", 30000, ok()), { action: "REVIEW_PAID_AFTER_CANCEL" });
  assert.deepEqual(decidePackageVerification("CANCELLED", 30000, ok(25000, 2)), { action: "REVIEW_PAID_AFTER_CANCEL" });
  assert.deepEqual(decidePackageVerification("CANCELLED", 30000, pending), { action: "RETURN", outcome: "PAYMENT_CANCELLED" });
});

test("החלטה: רכישה שנכשלה אינה סגורה לצמיתות - תשלום מאוחר בסכום הנכון מפעיל אותה", () => {
  assert.deepEqual(decidePackageVerification("FAILED", 30000, ok()), { action: "ACTIVATE", multiplePaid: false });
  assert.deepEqual(decidePackageVerification("FAILED", 30000, pending), { action: "RETURN", outcome: "PAYMENT_FAILED" });
});

test("החלטה: החזר אצל הספק חוסם הפעלה בכל מצב, גם כשיש עסקה ששולמה בסכום הנכון (הצלחה היסטורית אינה מספיקה)", () => {
  for (const status of ["PENDING", "FAILED", "CANCELLED"] as const) {
    assert.deepEqual(decidePackageVerification(status, 30000, { ...ok(), refundObserved: true }), { action: "REVIEW_REFUNDED" }, status);
    assert.deepEqual(decidePackageVerification(status, 30000, { ...ok(), refundedAgorot: 30000 }), { action: "REVIEW_REFUNDED" }, status);
    assert.deepEqual(decidePackageVerification(status, 30000, { ...pending, refundObserved: true }), { action: "REVIEW_REFUNDED" }, status);
  }
  // דחייה (9) אינה החזר: נשאר ממתין
  assert.deepEqual(decidePackageVerification("PENDING", 30000, { ...pending, refundedAgorot: 0 }), { action: "RETURN", outcome: "PENDING" });
});

test("החלטה: ממתין נשאר ממתין; ספק אחר שמדווח כישלון/ביטול סוגר רק רכישה ממתינה", () => {
  assert.deepEqual(decidePackageVerification("PENDING", 30000, pending), { action: "RETURN", outcome: "PENDING" });
  assert.deepEqual(decidePackageVerification("PENDING", 30000, { status: "FAILED", amountAgorot: 30000, failureCode: "DENIED" }), {
    action: "MARK",
    status: "FAILED",
    failureCode: "DENIED",
  });
  assert.deepEqual(decidePackageVerification("PENDING", 30000, { status: "CANCELLED", amountAgorot: 30000 }), {
    action: "MARK",
    status: "CANCELLED",
    failureCode: undefined,
  });
  assert.deepEqual(decidePackageVerification("FAILED", 30000, { status: "CANCELLED", amountAgorot: 30000 }), { action: "RETURN", outcome: "PAYMENT_FAILED" });
});

// ───── מסד מדומה ─────

interface Row {
  id: string;
  paymentId: string;
  kind: "MULTIPLE_PAID" | "PAID_AFTER_CANCEL";
  transactionIds: string;
  paidAgorot: number;
  status: "OPEN" | "RESOLVED";
  alertAttempts: number;
  lastAlertAttemptAt: Date | null;
  lastAlertError: string | null;
  alertSentAt: Date | null;
  createdAt: Date;
}

function fakeDb() {
  const rows: Row[] = [];
  const byId = (id: string) => rows.find((r) => r.id === id);
  const db = {
    paymentAnomaly: {
      create: async ({ data }: { data: Pick<Row, "paymentId" | "kind" | "transactionIds" | "paidAgorot"> }) => {
        await Promise.resolve();
        if (rows.some((r) => r.paymentId === data.paymentId && r.kind === data.kind && r.transactionIds === data.transactionIds)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row: Row = { id: `a${rows.length + 1}`, status: "OPEN", alertAttempts: 0, lastAlertAttemptAt: null, lastAlertError: null, alertSentAt: null, createdAt: new Date(0), ...data };
        rows.push(row);
        return { id: row.id };
      },
      findUniqueOrThrow: async ({ where }: { where: { id?: string; paymentId_kind_transactionIds?: Pick<Row, "paymentId" | "kind" | "transactionIds"> } }) => {
        const k = where.paymentId_kind_transactionIds;
        const row = where.id ? byId(where.id) : rows.find((r) => k && r.paymentId === k.paymentId && r.kind === k.kind && r.transactionIds === k.transactionIds);
        if (!row) throw new Error("not found");
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: { id: string; OR: { lastAlertAttemptAt: null | { lt: Date } }[] }; data: { lastAlertAttemptAt: Date } }) => {
        const row = byId(where.id);
        const due = (r: Row) => r.lastAlertAttemptAt === null || r.lastAlertAttemptAt < (where.OR[1].lastAlertAttemptAt as { lt: Date }).lt;
        if (!row || row.alertSentAt || row.status !== "OPEN" || !due(row)) return { count: 0 };
        row.lastAlertAttemptAt = data.lastAlertAttemptAt;
        row.alertAttempts += 1;
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        Object.assign(byId(where.id)!, data);
        return {};
      },
    },
  };
  return { rows, db: db as unknown as Pick<PrismaClient, "paymentAnomaly"> };
}

const TX = [
  { transactionId: "B2", amountAgorot: 30000 },
  { transactionId: "A1", amountAgorot: 30000 },
];

test("חריגה נרשמת פעם אחת והתראה נשלחת פעם אחת, גם בזיהוי חוזר ובמקביל", async () => {
  const { rows, db } = fakeDb();
  const sent: { subject: string; text: string }[] = [];
  const send = async (a: { subject: string; text: string }) => void sent.push(a);
  const now = new Date("2026-11-24T10:00:00Z");
  const results = await Promise.all(
    Array.from({ length: 5 }, () => recordPaymentAnomaly({ paymentId: "pay1", kind: "MULTIPLE_PAID", transactions: TX, environment: "sandbox", now, db, send }))
  );
  assert.equal(rows.length, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(sent.length, 1);
  assert.equal(rows[0].transactionIds, "A1,B2");
  assert.equal(rows[0].paidAgorot, 60000);
  assert.ok(rows[0].alertSentAt);

  await recordPaymentAnomaly({ paymentId: "pay1", kind: "MULTIPLE_PAID", transactions: TX, environment: "sandbox", now, db, send });
  assert.equal(sent.length, 1, "התראה שנשלחה לא נשלחת שוב");

  // עסקה נוספת = מידע חדש = חריגה חדשה
  await recordPaymentAnomaly({ paymentId: "pay1", kind: "MULTIPLE_PAID", transactions: [...TX, { transactionId: "C3", amountAgorot: 30000 }], environment: "sandbox", now, db, send });
  assert.equal(rows.length, 2);
  assert.equal(sent.length, 2);
});

test("התראה: תוכן ללא פרטי לקוח, עם סימון סביבת בדיקות; כשל שליחה נרשם ומנוסה שוב רק אחרי חלון ההמתנה", async () => {
  const { rows, db } = fakeDb();
  const t0 = new Date("2026-11-24T10:00:00Z");
  let fail = true;
  const sent: { subject: string; text: string }[] = [];
  const send = async (a: { subject: string; text: string }) => {
    if (fail) throw new Error("smtp_not_configured");
    sent.push(a);
  };
  const { id } = await recordPaymentAnomaly({ paymentId: "pay9", kind: "PAID_AFTER_CANCEL", transactions: [TX[0]], environment: "sandbox", now: t0, db, send });
  assert.equal(rows[0].alertSentAt, null);
  assert.equal(rows[0].lastAlertError, "smtp_not_configured");

  fail = false;
  assert.equal(await alertAnomaly({ anomalyId: id, environment: "sandbox", now: new Date(t0.getTime() + 60_000), db, send }), false);
  assert.equal(sent.length, 0);
  assert.equal(await alertAnomaly({ anomalyId: id, environment: "sandbox", now: new Date(t0.getTime() + ALERT_RETRY_MS + 1), db, send }), true);
  assert.equal(sent.length, 1);
  assert.equal(rows[0].alertAttempts, 2);
  assert.equal(rows[0].lastAlertError, null);
  assert.match(sent[0].subject, /^\[Sandbox\/Staging\] /);
  assert.match(sent[0].text, /pay9/);
  assert.match(sent[0].text, /B2/);
  assert.match(sent[0].text, /300\.00/);

  // חריגה שנסגרה ידנית אינה שולחת התראה
  rows[0].alertSentAt = null;
  rows[0].status = "RESOLVED";
  assert.equal(await alertAnomaly({ anomalyId: id, environment: "sandbox", now: new Date(t0.getTime() + 3 * ALERT_RETRY_MS), db, send }), false);
});

test("שגיאה חופשית בשליחה אינה נשמרת כמו שהיא (רק שם המחלקה), כדי לא לשמור פרטים מהשרת", async () => {
  const { rows, db } = fakeDb();
  const send = async () => {
    throw new Error("connect ECONNREFUSED smtp.internal:587 user=secret");
  };
  await recordPaymentAnomaly({ paymentId: "p", kind: "MULTIPLE_PAID", transactions: TX, environment: "sandbox", db, send });
  assert.equal(rows[0].lastAlertError, "Error");
});

test("טביעת חריגה: מזהים ייחודיים וממוינים", () => {
  assert.equal(anomalyFingerprint([{ transactionId: "9", amountAgorot: 1 }, { transactionId: "10", amountAgorot: 1 }, { transactionId: "9", amountAgorot: 1 }]), "10,9");
});
