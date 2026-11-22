import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGrowTestLink, validateGrowSandboxCheckoutUrl, type GrowTestLinkEnv } from "@/lib/payments/grow-sandbox-test-link";

const GOOD = "https://sandbox.meshulam.co.il/s/abc123";
const STAGING_HOST = "caps-staging-ppb1.onrender.com";
const env: GrowTestLinkEnv = {
  MAKE_DIAG_ENABLED: "true",
  STAGING_GATE_ENABLED: "true",
  STAGING_GATE_PASSWORD: "x".repeat(16),
  RENDER_EXTERNAL_HOSTNAME: STAGING_HOST,
  GROW_SANDBOX_TEST_CHECKOUT_URL: GOOD,
};

test("קישור תקין בדומיין ה-Sandbox מתקבל, כולל תת-דומיין", () => {
  assert.deepEqual(resolveGrowTestLink(STAGING_HOST, env), { status: "ok", url: GOOD });
  assert.equal(validateGrowSandboxCheckoutUrl("https://pay.sandbox.meshulam.co.il/x").ok, true);
});

test("רגרסיה: המארח המדויק sandbox.grow.link מתקבל, אך לא תתי-דומיינים, דומיינים דומים או grow.link כללי", () => {
  assert.equal(validateGrowSandboxCheckoutUrl("https://sandbox.grow.link/abc123").ok, true);
  assert.deepEqual(resolveGrowTestLink(STAGING_HOST, { ...env, GROW_SANDBOX_TEST_CHECKOUT_URL: "https://sandbox.grow.link/abc123" }), { status: "ok", url: "https://sandbox.grow.link/abc123" });
  for (const bad of [
    "https://grow.link/abc",
    "https://pay.sandbox.grow.link/abc",
    "https://evil.sandbox.grow.link/abc",
    "https://sandbox.grow.link.evil.com/abc",
    "https://evilsandbox.grow.link/abc",
    "https://xsandbox.grow.link/abc",
    "https://www.grow.link/abc",
    "https://production.grow.link/abc",
    "http://sandbox.grow.link/abc",
    "https://sandbox.grow.link:444/abc",
    "https://u:p@sandbox.grow.link/abc",
    "https://evil.example/?x=sandbox.grow.link",
  ]) {
    assert.equal(validateGrowSandboxCheckoutUrl(bad).ok, false, bad);
  }
});

test("כתובות שרירותיות, דומיין דומה, HTTP, פורט, פרטי גישה וסכמות זרות נדחים", () => {
  for (const bad of [
    "https://evil.example/x",
    "https://sandbox.meshulam.co.il.evil.com/x",
    "https://evilsandbox.meshulam.co.il/x",
    "https://meshulam.co.il/x",
    "https://secure.meshulam.co.il/x",
    "http://sandbox.meshulam.co.il/x",
    "https://sandbox.meshulam.co.il:8443/x",
    "https://user:pw@sandbox.meshulam.co.il/x",
    "https://evil.example/?u=sandbox.meshulam.co.il",
    "https://localhost/x",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    assert.equal(validateGrowSandboxCheckoutUrl(bad).ok, false, bad);
  }
});

test("בלי קישור מוגדר: הודעה ברורה (not_configured), ובקישור לא תקין: invalid", () => {
  assert.deepEqual(resolveGrowTestLink(STAGING_HOST, { ...env, GROW_SANDBOX_TEST_CHECKOUT_URL: undefined }), { status: "not_configured" });
  assert.deepEqual(resolveGrowTestLink(STAGING_HOST, { ...env, GROW_SANDBOX_TEST_CHECKOUT_URL: "  " }), { status: "not_configured" });
  assert.equal(resolveGrowTestLink(STAGING_HOST, { ...env, GROW_SANDBOX_TEST_CHECKOUT_URL: "https://evil.example/x" }).status, "invalid");
});

test("ב-Production, כשהכלי כבוי או כשהשער לא פעיל: unavailable גם אם הקישור מוגדר", () => {
  assert.equal(resolveGrowTestLink(STAGING_HOST, { ...env, RENDER_EXTERNAL_HOSTNAME: "caps.co.il" }).status, "unavailable");
  assert.equal(resolveGrowTestLink(STAGING_HOST, { ...env, MAKE_DIAG_ENABLED: "false" }).status, "unavailable");
  assert.equal(resolveGrowTestLink(STAGING_HOST, { ...env, STAGING_GATE_ENABLED: "false" }).status, "unavailable");
});
