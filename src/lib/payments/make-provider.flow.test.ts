import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { InMemoryMockStore, type MockStore } from "@/lib/payments/mock-store";
import { MakeGrowPaymentProvider, parseVerifyTransactions, type MakeCheckoutFlow } from "@/lib/payments/make-provider";
import { getPaymentProvider } from "@/lib/payments/config";
import { PaymentConfigError, PaymentError } from "@/lib/payments/provider";

/**
 * שני מסלולי יצירת דף התשלום דרך Make: "link" (Create Payment Link, הקיים) ו-"process" (createPaymentProcess, לדף
 * שניתן להטמיע). המטרה: מסלול הקישורים לא משתנה בכלום, ומסלול process שומר על אותם מנגנוני אבטחה (idempotency,
 * קשירת עסקה לתשלום, אימות לפני זיכוי), עם תרחישי Make נפרדים ובחירת תרחיש אימות לפי המסלול שבו התשלום נוצר.
 */

const LINK_CREATE = "https://hook.eu1.make.com/link-create";
const LINK_VERIFY = "https://hook.eu1.make.com/link-verify";
const PROC_CREATE = "https://hook.eu1.make.com/process-create";
const PROC_VERIFY = "https://hook.eu1.make.com/process-verify";
const BASE = "https://caps-staging-ppb1.onrender.com";
const db = {
  user: { findUnique: async () => ({ name: "דנה כהן", phone: "0501234567", email: "d@x.com" }) },
} as unknown as PrismaClient;

type Body = Record<string, unknown>;
interface Call {
  url: string;
  body: Body;
  key: string;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup(flow: MakeCheckoutFlow | undefined, opts: { withProcess?: boolean; store?: MockStore; verify?: (url: string, b: Body) => Response } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const key = new Headers(init?.headers).get("x-make-apikey") ?? "";
    calls.push({ url: String(url), body, key });
    if (String(url) === LINK_VERIFY || String(url) === PROC_VERIFY) {
      return opts.verify ? opts.verify(String(url), body) : ok({ reference: body.reference, processId: body.processId });
    }
    if (String(url) === PROC_CREATE) return ok({ url: "https://sandbox.meshulam.co.il/mtx/spa/p1", processId: "P-555", processToken: "PT" });
    return ok({ url: "https://sandbox.grow.link/abc", processId: "L-82439", processToken: "LT" });
  }) as unknown as typeof fetch;
  const p = new MakeGrowPaymentProvider({
    webhookUrl: LINK_CREATE,
    apiKey: "k".repeat(32),
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.link", "sandbox.meshulam.co.il"],
    verify: { webhookUrl: LINK_VERIFY, apiKey: "v".repeat(32) },
    flow,
    process:
      opts.withProcess === false
        ? undefined
        : { create: { webhookUrl: PROC_CREATE, apiKey: "p".repeat(32) }, verify: { webhookUrl: PROC_VERIFY, apiKey: "q".repeat(32) } },
    returnBaseUrl: BASE,
    db,
    store: opts.store ?? new InMemoryMockStore(),
    fetchImpl,
    timeoutMs: 500,
  });
  return { p, calls };
}

let n = 0;
const request = () => ({
  amountAgorot: 30000,
  currency: "ILS" as const,
  description: "חבילת 5 שעות",
  idempotencyKey: `package:u1:flow-${n++}-abcdefgh`,
  customerRef: "u1",
  metadata: { packageHours: "5" },
});

test("מסלול link (ברירת מחדל): גוף הבקשה ל-Make זהה למה שהיה - בלי flow ובלי cancelUrl, לתרחיש הקיים", async () => {
  for (const flow of [undefined, "link" as const]) {
    const { p, calls } = setup(flow);
    const r = await p.createPaymentRequest(request());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LINK_CREATE);
    assert.equal(calls[0].key, "k".repeat(32));
    assert.deepEqual(Object.keys(calls[0].body).sort(), [
      "amount", "currency", "description", "email", "fullName", "idempotencyKey", "notifyUrl", "phone", "purpose", "reference", "returnUrl",
    ]);
    assert.equal(r.checkoutUrl, "https://sandbox.grow.link/abc");
  }
});

test("מסלול process: יוצר דרך תרחיש process, מצהיר על המסלול ושולח cancelUrl לדף החזרה שלנו", async () => {
  const { p, calls } = setup("process");
  const r = await p.createPaymentRequest(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PROC_CREATE);
  assert.equal(calls[0].key, "p".repeat(32));
  assert.equal(calls[0].body.flow, "process");
  assert.equal(calls[0].body.returnUrl, `${BASE}/payments/return`);
  assert.equal(calls[0].body.cancelUrl, `${BASE}/payments/return`);
  // ההתראה עדיין חתומה (אותו מנגנון כמו במסלול הקישורים)
  assert.match(String(calls[0].body.notifyUrl), /^https:\/\/caps-staging-ppb1\.onrender\.com\/api\/payments\/webhook\/make-grow\?ref=make%3A[0-9a-f]{32}&sig=[0-9a-f]{64}$/);
  assert.equal(r.checkoutUrl, "https://sandbox.meshulam.co.il/mtx/spa/p1");
  // מזהי Grow לא חוזרים ללקוח
  assert.doesNotMatch(JSON.stringify(r), /P-555|PT/);
});

test("מסלול process: idempotency נשמר - אותו מפתח, קריאה אחת ל-Make ואותו קישור", async () => {
  const { p, calls } = setup("process");
  const req = request();
  const [a, b] = await Promise.all([p.createPaymentRequest(req), p.createPaymentRequest(req)]);
  const c = await p.createPaymentRequest(req);
  assert.equal(calls.length, 1);
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  assert.equal(a.providerPaymentId, c.providerPaymentId);
});

test("מסלול process: קישור מחוץ לדומיינים המאושרים נדחה", async () => {
  const calls: Call[] = [];
  const p = new MakeGrowPaymentProvider({
    webhookUrl: LINK_CREATE,
    apiKey: "k".repeat(32),
    environment: "sandbox",
    allowedCheckoutHosts: ["grow.link"],
    verify: { webhookUrl: LINK_VERIFY, apiKey: "v".repeat(32) },
    flow: "process",
    process: { create: { webhookUrl: PROC_CREATE, apiKey: "p".repeat(32) }, verify: { webhookUrl: PROC_VERIFY, apiKey: "q".repeat(32) } },
    db,
    store: new InMemoryMockStore(),
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)), key: "" });
      return ok({ url: "https://sandbox.meshulam.co.il/mtx/spa/p1", processId: "P", processToken: "T" });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(p.createPaymentRequest(request()), /דומיין מאושר/);
});

const paidProcess = (b: Body, over: Record<string, unknown> = {}) =>
  ok({
    format: "v2",
    flow: "process",
    reference: b.reference,
    processId: b.processId,
    grow: { transactions: [{ statusCode: "2", sum: "300", transactionId: "TX1", processId: "P-555", ...over }] },
  });

test("מסלול process: האימות עובר בתרחיש האימות של process, והעסקה נקשרת למזהה התהליך", async () => {
  const { p, calls } = setup("process", { verify: (_u, b) => paidProcess(b) });
  const r = await p.createPaymentRequest(request());
  const v = await p.getPaymentStatus(r.providerPaymentId);
  assert.equal(v.status, "SUCCEEDED");
  assert.equal(v.amountAgorot, 30000);
  const verifyCall = calls[1];
  assert.equal(verifyCall.url, PROC_VERIFY);
  assert.equal(verifyCall.key, "q".repeat(32));
  assert.deepEqual(verifyCall.body, { reference: r.providerPaymentId, processId: "P-555", processToken: "PT" });
});

test("מסלול process: עסקה של תהליך אחר, או בלי מזהה תהליך, נדחית (paymentLinkProcessId לא מחליף אותו)", async () => {
  for (const over of [{ processId: "P-OTHER" }, { processId: undefined }, { processId: undefined, paymentLinkProcessId: "P-555" }]) {
    const { p } = setup("process", { verify: (_u, b) => paidProcess(b, over) });
    const r = await p.createPaymentRequest(request());
    await assert.rejects(p.getPaymentStatus(r.providerPaymentId), PaymentError, JSON.stringify(over));
  }
});

test("מסלול process: תשובה שאינה מצהירה flow=process (תרחיש אימות שגוי או legacy) נדחית ואינה מאשרת", async () => {
  const bad = [
    (b: Body) => ok({ format: "v2", reference: b.reference, processId: b.processId, grow: { transactions: [{ statusCode: "2", sum: "300", transactionId: "T", processId: "P-555" }] } }),
    (b: Body) => ok({ reference: b.reference, processId: b.processId, statusCode: "2", sum: "300", transactionId: "T" }),
    (b: Body) => ok({ format: "v2", flow: "link", reference: b.reference, processId: b.processId, grow: { transactions: [] } }),
  ];
  for (const verify of bad) {
    const { p } = setup("process", { verify: (_u, b) => verify(b) });
    const r = await p.createPaymentRequest(request());
    await assert.rejects(p.getPaymentStatus(r.providerPaymentId), PaymentError);
  }
});

test("מסלול link: תשובת אימות שמצהירה flow=process נדחית; flow=link או בלי flow - כרגיל", () => {
  const tx = [{ statusCode: "2", sum: "300", transactionId: "T", paymentLinkProcessId: "L1" }];
  assert.throws(() => parseVerifyTransactions({ format: "v2", flow: "process", grow: { transactions: tx } }, "L1"), PaymentError);
  assert.equal(parseVerifyTransactions({ format: "v2", flow: "link", grow: { transactions: tx } }, "L1").paid.length, 1);
  assert.equal(parseVerifyTransactions({ format: "v2", grow: { transactions: tx } }, "L1").paid.length, 1);
});

test("מעבר בין מסלולים לא שובר תשלומים פתוחים: כל תשלום מאומת בתרחיש של המסלול שבו נוצר", async () => {
  const store = new InMemoryMockStore();
  const verify = (url: string, b: Body) =>
    url === PROC_VERIFY
      ? paidProcess(b)
      : ok({ format: "v2", reference: b.reference, processId: b.processId, grow: { transactions: [{ statusCode: "2", sum: "300", transactionId: "TXL", paymentLinkProcessId: "L-82439" }] } });

  const linkEra = setup("link", { store, verify });
  const linkPayment = await linkEra.p.createPaymentRequest(request());
  const processEra = setup("process", { store, verify });
  const processPayment = await processEra.p.createPaymentRequest(request());

  // אחרי מעבר ל-process: תשלום שנוצר כקישור עדיין מאומת בתרחיש הקישורים
  assert.equal((await processEra.p.getPaymentStatus(linkPayment.providerPaymentId)).status, "SUCCEEDED");
  assert.equal(processEra.calls.at(-1)?.url, LINK_VERIFY);
  // חזרה ל-link (עם תרחישי process עדיין מוגדרים): תשלום process ממשיך להתאמת בתרחיש process
  const backToLink = setup("link", { store, verify });
  assert.equal((await backToLink.p.getPaymentStatus(processPayment.providerPaymentId)).status, "SUCCEEDED");
  assert.equal(backToLink.calls.at(-1)?.url, PROC_VERIFY);
  // בלי תרחישי process בכלל: תשלום process לא מאומת (כשל זמני, נשאר ממתין) ולא נשלח לתרחיש הקישורים
  const noProcess = setup("link", { store, verify, withProcess: false });
  await assert.rejects(noProcess.p.getPaymentStatus(processPayment.providerPaymentId), /אינו מוגדר/);
  assert.equal(noProcess.calls.length, 0);
});

test("בנאי: process בלי תרחישים, מסלול לא מוכר, HTTP או מפתח קצר - נחסמים", () => {
  const base = {
    webhookUrl: LINK_CREATE,
    apiKey: "k".repeat(32),
    environment: "sandbox" as const,
    allowedCheckoutHosts: ["grow.link"],
    db,
    store: new InMemoryMockStore(),
  };
  const good = { create: { webhookUrl: PROC_CREATE, apiKey: "p".repeat(32) }, verify: { webhookUrl: PROC_VERIFY, apiKey: "q".repeat(32) } };
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, flow: "process" }), /Payment Process/);
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, flow: "other" as MakeCheckoutFlow }), /לא מוכר/);
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, flow: "process", process: { ...good, create: { webhookUrl: "http://x.com/h", apiKey: "p".repeat(32) } } }), /HTTPS/);
  assert.throws(() => new MakeGrowPaymentProvider({ ...base, flow: "process", process: { ...good, verify: { webhookUrl: PROC_VERIFY, apiKey: "short" } } }), /קצר/);
  assert.doesNotThrow(() => new MakeGrowPaymentProvider({ ...base, flow: "process", process: good }));
});

test("תצורה (env): ברירת מחדל link; process דורש את ארבעת המשתנים; הגדרה חלקית חוסמת; ערך לא מוכר חוסם", () => {
  const staging = {
    PAYMENT_PROVIDER: "make",
    PAYMENT_ENVIRONMENT: "sandbox",
    MAKE_VERIFICATION_CONFIRMED: "true",
    MAKE_PAYMENT_WEBHOOK_URL: LINK_CREATE,
    MAKE_PAYMENT_API_KEY: "k".repeat(32),
    MAKE_PAYMENT_CHECKOUT_HOSTS: "sandbox.grow.link,sandbox.meshulam.co.il",
    MAKE_VERIFY_WEBHOOK_URL: LINK_VERIFY,
    MAKE_VERIFY_API_KEY: "v".repeat(32),
    MAKE_PAYMENT_RETURN_BASE_URL: BASE,
    STAGING_GATE_ENABLED: "true",
    STAGING_GATE_PASSWORD: "p".repeat(16),
    RENDER_EXTERNAL_HOSTNAME: "caps-staging-ppb1.onrender.com",
  };
  const proc = {
    MAKE_PROCESS_WEBHOOK_URL: PROC_CREATE,
    MAKE_PROCESS_API_KEY: "p".repeat(32),
    MAKE_PROCESS_VERIFY_WEBHOOK_URL: PROC_VERIFY,
    MAKE_PROCESS_VERIFY_API_KEY: "q".repeat(32),
  };
  assert.equal(getPaymentProvider(staging).name, "make-grow");
  assert.equal(getPaymentProvider({ ...staging, MAKE_PAYMENT_FLOW: "link" }).name, "make-grow");
  assert.equal(getPaymentProvider({ ...staging, ...proc }).name, "make-grow");
  assert.equal(getPaymentProvider({ ...staging, ...proc, MAKE_PAYMENT_FLOW: "process" }).name, "make-grow");

  const blocked = (env: Record<string, string>, re: RegExp) =>
    assert.throws(() => getPaymentProvider(env), (e: Error) => e instanceof PaymentConfigError && re.test(e.message) && !e.message.includes("p".repeat(32)));
  blocked({ ...staging, MAKE_PAYMENT_FLOW: "process" }, /MAKE_PROCESS_/);
  blocked({ ...staging, MAKE_PROCESS_WEBHOOK_URL: PROC_CREATE }, /MAKE_PROCESS_/);
  blocked({ ...staging, ...proc, MAKE_PROCESS_VERIFY_API_KEY: "short" }, /MAKE_PROCESS_/);
  blocked({ ...staging, ...proc, MAKE_PROCESS_WEBHOOK_URL: "http://hook.example/x" }, /MAKE_PROCESS_/);
  blocked({ ...staging, MAKE_PAYMENT_FLOW: "iframe" }, /MAKE_PAYMENT_FLOW/);
});

test("מסלול process: processId ברמת התהליך (data של getPaymentProcessInfo כפי שהוא) קושר עסקה שאין בה מזהה משלה", async () => {
  const whole = (grow: Record<string, unknown>) => (_u: string, b: Body) =>
    ok({ format: "v2", flow: "process", reference: b.reference, processId: b.processId, grow });
  const tx = (over: Record<string, unknown> = {}) => ({ statusCode: "2", sum: "300", transactionId: "TX9", ...over });

  // תהליך נכון ברמת התשובה, עסקה בלי processId -> מאושר
  let s = setup("process", { verify: whole({ processId: "P-555", transactions: [tx()] }) });
  let r = await s.p.createPaymentRequest(request());
  assert.equal((await s.p.getPaymentStatus(r.providerPaymentId)).status, "SUCCEEDED");

  // ברמת התשובה תהליך אחר -> נדחה גם אם העסקה עצמה "נכונה"
  s = setup("process", { verify: whole({ processId: "P-OTHER", transactions: [tx({ processId: "P-555" })] }) });
  r = await s.p.createPaymentRequest(request());
  await assert.rejects(s.p.getPaymentStatus(r.providerPaymentId), PaymentError);

  // עסקה עם processId של תהליך אחר -> נדחית, גם כשרמת התשובה נכונה
  s = setup("process", { verify: whole({ processId: "P-555", transactions: [tx({ processId: "P-OTHER" })] }) });
  r = await s.p.createPaymentRequest(request());
  await assert.rejects(s.p.getPaymentStatus(r.providerPaymentId), PaymentError);

  // אין processId בשום רמה בעסקה ששולמה -> נדחה (כשל סגור)
  s = setup("process", { verify: whole({ transactions: [tx()] }) });
  r = await s.p.createPaymentRequest(request());
  await assert.rejects(s.p.getPaymentStatus(r.providerPaymentId), PaymentError);

  // אין עסקאות עדיין -> ממתין
  s = setup("process", { verify: whole({ processId: "P-555", transactions: [] }) });
  r = await s.p.createPaymentRequest(request());
  assert.equal((await s.p.getPaymentStatus(r.providerPaymentId)).status, "PENDING");
});

test("מסלול link: processId ברמת התשובה אינו מחליף את paymentLinkProcessId", () => {
  assert.throws(
    () => parseVerifyTransactions({ format: "v2", grow: { processId: "L1", transactions: [{ statusCode: "2", sum: "300", transactionId: "T" }] } }, "L1"),
    PaymentError
  );
});
