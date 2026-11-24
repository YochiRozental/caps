import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKOUT_LINK_TTL_MS,
  RETURN_MESSAGE_TYPE,
  buildReturnMessage,
  canReopenCheckout,
  isEmbeddableCheckoutUrl,
  parseReturnMessage,
  parseStoredPurchase,
  pendingPackagePaymentIds,
  resolvePurchaseOutcome,
  returnHintFromSearch,
  returnPageAction,
} from "@/lib/payments/embedded-checkout";

const ORIGIN = "https://caps-staging.onrender.com";
const frame = { name: "iframe-window" };
const other = { name: "other-window" };
const okMsg = { type: RETURN_MESSAGE_TYPE, hint: "success" };

// ───── הודעת החזרה מה-iframe: רמז בלבד, ורק מהמקור הנכון ─────

test("הודעה מה-origin שלנו ומה-iframe שפתחנו מתקבלת", () => {
  assert.deepEqual(parseReturnMessage({ origin: ORIGIN, data: okMsg, source: frame }, { origin: ORIGIN, sources: [frame] }), okMsg);
});

test("הודעה מ-origin אחר (דף Grow או צד שלישי) נדחית, גם אם המבנה זהה", () => {
  for (const origin of ["https://sandbox.meshulam.co.il", "https://evil.example", "null", ORIGIN + ".evil.com"]) {
    assert.equal(parseReturnMessage({ origin, data: okMsg, source: frame }, { origin: ORIGIN, sources: [frame] }), null);
  }
});

test("הודעה מחלון אחר (לא ה-iframe שפתחנו) או בלי מקור נדחית", () => {
  assert.equal(parseReturnMessage({ origin: ORIGIN, data: okMsg, source: other }, { origin: ORIGIN, sources: [frame] }), null);
  assert.equal(parseReturnMessage({ origin: ORIGIN, data: okMsg, source: null }, { origin: ORIGIN, sources: [frame, undefined] }), null);
});

test("מבנה הודעה לא תקין נדחה; רמז לא מוכר הופך ל-unknown", () => {
  const exp = { origin: ORIGIN, sources: [frame] };
  for (const data of [null, "paid", { type: "other", hint: "success" }, { status: "SUCCEEDED" }, 42]) {
    assert.equal(parseReturnMessage({ origin: ORIGIN, data, source: frame }, exp), null);
  }
  assert.deepEqual(parseReturnMessage({ origin: ORIGIN, data: { type: RETURN_MESSAGE_TYPE, hint: "PAID!" }, source: frame }, exp), {
    type: RETURN_MESSAGE_TYPE,
    hint: "unknown",
  });
});

test("ההודעה לעולם אינה נושאת סטטוס תשלום - רק רמז תצוגה", () => {
  const msg = buildReturnMessage("?response=success&status=paid&sum=1&transactionId=x");
  assert.deepEqual(Object.keys(msg).sort(), ["hint", "type"]);
  assert.equal(resolvePurchaseOutcome(msg.hint), "pending");
});

test("רמז מכתובת ההחזרה של Grow", () => {
  assert.equal(returnHintFromSearch("?response=success"), "success");
  assert.equal(returnHintFromSearch("?response=SUCCESS"), "success");
  assert.equal(returnHintFromSearch("?response=cancel"), "cancel");
  assert.equal(returnHintFromSearch("?response=failure"), "cancel");
  assert.equal(returnHintFromSearch(""), "unknown");
  assert.equal(returnHintFromSearch("?response=whatever"), "unknown");
});

test("פעולת דף החזרה לפי הקשר החלון", () => {
  assert.equal(returnPageAction({ inIframe: true, hasOpener: false }), "notify-parent");
  assert.equal(returnPageAction({ inIframe: true, hasOpener: true }), "notify-parent");
  assert.equal(returnPageAction({ inIframe: false, hasOpener: true }), "notify-opener");
  assert.equal(returnPageAction({ inIframe: false, hasOpener: false }), "redirect");
});

// ───── קישור תשלום להטמעה ─────

test("רק קישור HTTPS בלי פרטי גישה מוטמע", () => {
  assert.equal(isEmbeddableCheckoutUrl("https://sandbox.meshulam.co.il/far?l=abc"), true);
  for (const bad of ["http://sandbox.meshulam.co.il/far", "javascript:alert(1)", "data:text/html,x", "https://u:p@sandbox.meshulam.co.il/", "", undefined, 5, "not a url", "https://x/" + "a".repeat(2100)]) {
    assert.equal(isEmbeddableCheckoutUrl(bad), false, String(bad));
  }
});

// ───── רכישה שמורה ─────

test("רכישה שמורה: תקינה נקראת, פגומה מוחזרת כ-null", () => {
  const good = { paymentId: "cmabc12345", providerPaymentId: "make:1", hours: 5, amountAgorot: 50000, checkoutUrl: "https://sandbox.meshulam.co.il/far?l=1", checkoutCreatedAt: 1000 };
  assert.deepEqual(parseStoredPurchase(JSON.stringify(good)), good);
  for (const raw of [null, "", "{", "null", "[]", JSON.stringify({ ...good, paymentId: "../x" }), JSON.stringify({ ...good, hours: "5" }), JSON.stringify({ ...good, amountAgorot: 1.5 })]) {
    assert.equal(parseStoredPurchase(raw), null, String(raw));
  }
});

test("רכישה שמורה עם קישור לא בטוח נשמרת בלי הקישור", () => {
  const p = parseStoredPurchase(JSON.stringify({ paymentId: "cmabc12345", hours: 5, amountAgorot: 50000, checkoutUrl: "javascript:alert(1)", checkoutCreatedAt: 1 }));
  assert.ok(p);
  assert.equal(p.checkoutUrl, undefined);
  assert.equal(canReopenCheckout(p, 2), false);
});

test("פתיחה מחדש של דף התשלום רק בתוך חלון התוקף של Grow", () => {
  const p = { paymentId: "cmabc12345", hours: 5, amountAgorot: 1, checkoutUrl: "https://sandbox.meshulam.co.il/far?l=1", checkoutCreatedAt: 1_000_000 };
  assert.equal(canReopenCheckout(p, 1_000_000 + 60_000), true);
  assert.equal(canReopenCheckout(p, 1_000_000 + CHECKOUT_LINK_TTL_MS), false);
  assert.equal(canReopenCheckout({ ...p, checkoutUrl: undefined }, 1_000_001), false);
});

// ───── תוצאת השרת: היחידה שקובעת הצלחה ─────

test("רק הפעלת חבילה מאומתת בשרת נחשבת הצלחה", () => {
  assert.equal(resolvePurchaseOutcome("PACKAGE_ACTIVATED"), "activated");
  assert.equal(resolvePurchaseOutcome("ALREADY_ACTIVATED"), "activated");
  assert.equal(resolvePurchaseOutcome("PAYMENT_FAILED"), "failed");
  assert.equal(resolvePurchaseOutcome("PAYMENT_CANCELLED"), "cancelled");
  assert.equal(resolvePurchaseOutcome("AMOUNT_MISMATCH"), "mismatch");
  for (const v of ["PENDING", "SUCCEEDED", "success", "CONFIRMED", undefined, null, 1]) {
    assert.equal(resolvePurchaseOutcome(v), "pending", String(v));
  }
});

// ───── שחזור רכישה אחרי סגירת החלונית/הדפדפן ─────

test("שחזור: רק רכישות חבילה ממתינות מהיומיים האחרונים, עד 3", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const recent = "2026-11-24T11:00:00Z";
  const entries = [
    { id: "pay:pkgpending1", kind: "PACKAGE_PURCHASE", status: "PENDING", at: recent },
    { id: "pay:pkgdone0001", kind: "PACKAGE_PURCHASE", status: "SUCCEEDED", at: recent },
    { id: "pay:booking001", kind: "BOOKING_PAYMENT", status: "PENDING", at: recent },
    { id: "pay:pkgold00001", kind: "PACKAGE_PURCHASE", status: "PENDING", at: "2026-11-01T00:00:00Z" },
    { id: "use:pkgpending", kind: "PACKAGE_PURCHASE", status: "PENDING", at: recent },
    { id: "pay:../../x", kind: "PACKAGE_PURCHASE", status: "PENDING", at: recent },
    { id: "pay:pkgpending2", kind: "PACKAGE_PURCHASE", status: "PENDING", at: recent },
    { id: "pay:pkgpending3", kind: "PACKAGE_PURCHASE", status: "PENDING", at: recent },
    { id: "pay:pkgpending4", kind: "PACKAGE_PURCHASE", status: "PENDING", at: recent },
  ];
  assert.deepEqual(pendingPackagePaymentIds(entries, now), ["pkgpending1", "pkgpending2", "pkgpending3"]);
  assert.deepEqual(pendingPackagePaymentIds([], now), []);
});
