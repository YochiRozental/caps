import { test } from "node:test";
import assert from "node:assert/strict";
import { framingAllowed, probeCheckoutEmbeddable } from "@/lib/payments/frame-policy";
import { checkoutPhaseFor, parseStoredPurchase } from "@/lib/payments/embedded-checkout";

const OURS = "https://caps-staging-ppb1.onrender.com";
const LINK = "https://sandbox.grow.link/MTg1Mw~abc";
const h = (o: Record<string, string>) => new Headers(o);

// הכותרת שנמדדה בפועל ב-sandbox.grow.link (נובמבר 2026)
const GROW_LINK_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors https://grow.website https://*.grow.website; upgrade-insecure-requests; frame-src https://*;";
// הכותרת שנמדדה ב-sandbox.meshulam.co.il (אין frame-ancestors ואין X-Frame-Options)
const MESHULAM_CSP = "default-src 'unsafe-inline' *.ssl.google-analytics.com * data: ; script-src 'self' 'unsafe-eval' 'unsafe-inline' *.meshulam.co.il ;object-src 'none' ;";

test("sandbox.grow.link כפי שהוא היום: אוסר הטמעה באתר שלנו", () => {
  assert.equal(framingAllowed(h({ "content-security-policy": GROW_LINK_CSP }), OURS, LINK), false);
});

test("sandbox.meshulam.co.il: אין הגבלה - מותר", () => {
  assert.equal(framingAllowed(h({ "content-security-policy": MESHULAM_CSP }), OURS, "https://sandbox.meshulam.co.il/far?l=x"), true);
  assert.equal(framingAllowed(h({}), OURS, LINK), true);
});

test("אחרי אישור דומיין ב-Grow (הדומיין שלנו ברשימה) - מותר", () => {
  for (const src of [OURS, "caps-staging-ppb1.onrender.com", "https://*.onrender.com", "*", "https:"]) {
    assert.equal(framingAllowed(h({ "content-security-policy": `frame-ancestors https://grow.website ${src}` }), OURS, LINK), true, src);
  }
});

test("מקורות שאינם מתאימים - אסור", () => {
  for (const src of ["'none'", "'self'", "http://caps-staging-ppb1.onrender.com", "https://onrender.com", "https://*.caps-staging-ppb1.onrender.com", "https://caps-staging-ppb1.onrender.com:8443", "https://evil.com"]) {
    assert.equal(framingAllowed(h({ "content-security-policy": `frame-ancestors ${src}` }), OURS, LINK), false, src);
  }
});

test("X-Frame-Options: DENY/SAMEORIGIN אוסרים, אלא אם frame-ancestors מתיר במפורש", () => {
  assert.equal(framingAllowed(h({ "x-frame-options": "DENY" }), OURS, LINK), false);
  assert.equal(framingAllowed(h({ "x-frame-options": "SAMEORIGIN" }), OURS, LINK), false);
  assert.equal(framingAllowed(h({ "x-frame-options": "SAMEORIGIN", "content-security-policy": `frame-ancestors ${OURS}` }), OURS, LINK), true);
});

test("כמה מדיניויות בכותרת: כל אחת חייבת להתיר", () => {
  assert.equal(framingAllowed(h({ "content-security-policy": `frame-ancestors *, frame-ancestors 'none'` }), OURS, LINK), false);
});

test("בדיקת השרת: iframe רק כשהדף נטען (2xx) וכותרותיו מתירות; כל השאר = חלון נפרד", async () => {
  const blocked = (async () => new Response("", { headers: { "content-security-policy": GROW_LINK_CSP } })) as unknown as typeof fetch;
  const open = (async () => new Response("", {})) as unknown as typeof fetch;
  // דף חסימת-בוטים/שגיאה שמוחזר לשרת: אין בו את כותרות הדף האמיתי, ולכן אסור להסיק ממנו "מותר"
  const botWall = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  const serverError = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  const broken = (async () => {
    throw new Error("timeout");
  }) as unknown as typeof fetch;
  assert.deepEqual(await probeCheckoutEmbeddable(LINK, OURS, blocked), { embeddable: false, reason: "headers_forbid" });
  assert.deepEqual(await probeCheckoutEmbeddable(LINK, OURS, open), { embeddable: true, reason: "headers_allow" });
  assert.deepEqual(await probeCheckoutEmbeddable(LINK, OURS, botWall), { embeddable: false, reason: "http_403" });
  assert.deepEqual(await probeCheckoutEmbeddable(LINK, OURS, serverError), { embeddable: false, reason: "http_503" });
  assert.deepEqual(await probeCheckoutEmbeddable(LINK, OURS, broken), { embeddable: false, reason: "probe_failed" });
});

test("החלונית: iframe רק כשלא ידוע שהספק אוסר; הבחירה נשמרת לפתיחה מחדש", () => {
  assert.equal(checkoutPhaseFor(false), "external-ready");
  assert.equal(checkoutPhaseFor(true), "checkout");
  assert.equal(checkoutPhaseFor(undefined), "checkout");
  const p = parseStoredPurchase(JSON.stringify({ paymentId: "cmabc12345", hours: 5, amountAgorot: 1, checkoutUrl: LINK, checkoutCreatedAt: 1, embeddable: false }));
  assert.equal(p?.embeddable, false);
  assert.equal(parseStoredPurchase(JSON.stringify({ paymentId: "cmabc12345", hours: 5, amountAgorot: 1, embeddable: "no" }))?.embeddable, undefined);
});
