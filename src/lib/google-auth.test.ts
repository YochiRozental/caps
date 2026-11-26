import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLinkIntent, readLinkIntent } from "@/lib/google-auth";

process.env.AUTH_SECRET ??= "test-secret-for-google-link-intent";

describe("אסימון כוונת קישור Google", () => {
  test("חתום ובתוקף -> userId; זיוף, פג תוקף וריק -> null", () => {
    const t = createLinkIntent("user1", 1_000);
    assert.equal(readLinkIntent(t, 2_000), "user1");
    assert.equal(readLinkIntent(t, 1_000 + 11 * 60_000), null);
    assert.equal(readLinkIntent(t.replace("user1", "user2"), 2_000), null);
    assert.equal(readLinkIntent(`${t}x`, 2_000), null);
    assert.equal(readLinkIntent("", 2_000), null);
    assert.equal(readLinkIntent(undefined, 2_000), null);
  });
});

// בדיקות מול PostgreSQL מקומי (npm run test:db -- google). רצות רק כש-GOOGLE_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי *_test
const testUrl = process.env.GOOGLE_TEST_DATABASE_URL;

describe("התחברות Google מול מסד נתונים", { skip: !testUrl && "GOOGLE_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let g: typeof import("@/lib/google-auth");
  let pw: typeof import("@/lib/password");

  const ident = (sub: string, email: string, extra: Record<string, unknown> = {}) => ({
    sub, email, emailVerified: true, givenName: "דנה", familyName: "לוי", ...extra,
  });
  const resolve = (i: ReturnType<typeof ident>, link: string | null = null) => g.resolveGoogleLogin(i, link, prisma);

  before(async () => {
    const parsed = new URL(testUrl!);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test")) throw new Error("מסד בדיקות מקומי בלבד");
    const { PrismaClient } = await import("@/generated/prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl }) });
    process.env.DATABASE_URL = testUrl;
    g = await import("@/lib/google-auth");
    pw = await import("@/lib/password");
  });
  beforeEach(async () => {
    await prisma.oAuthAccount.deleteMany({});
    await prisma.user.deleteMany({});
  });
  after(async () => {
    await prisma?.$disconnect();
  });

  test("משתמש חדש: נוצר פעם אחת כ-CLIENT/PENDING בלי סיסמה, והתחברות חוזרת לא יוצרת כפילות", async () => {
    const a = await resolve(ident("sub-1", "Dana@Example.com"));
    assert.ok(a.ok);
    const b = await resolve(ident("sub-1", "dana@example.com"));
    assert.ok(b.ok && a.ok && b.userId === a.userId);
    const users = await prisma.user.findMany();
    assert.equal(users.length, 1);
    assert.deepEqual([users[0].role, users[0].status, users[0].passwordHash, users[0].email, users[0].firstName, users[0].phone], ["CLIENT", "PENDING", null, "dana@example.com", "דנה", null]);
  });

  test("בקשות מקבילות לאותו משתמש חדש: משתמש אחד בלבד", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => resolve(ident("sub-par", "par@example.com"))));
    assert.ok(results.every((r) => r.ok));
    assert.equal(new Set(results.map((r) => (r.ok ? r.userId : ""))).size, 1);
    assert.equal(await prisma.user.count(), 1);
    assert.equal(await prisma.oAuthAccount.count(), 1);
  });

  test("אימייל לא מאומת נדחה; אימייל תואם לחשבון קיים לא מקושר אוטומטית (גם אם מאומת)", async () => {
    assert.deepEqual(await resolve(ident("s2", "x@example.com", { emailVerified: false })), { ok: false, error: "google_email_unverified" });
    const existing = await prisma.user.create({ data: { name: "ישן", email: "old@example.com", passwordHash: await pw.hashPassword("pass1234") } });
    assert.deepEqual(await resolve(ident("s3", "old@example.com")), { ok: false, error: "google_email_exists" });
    assert.equal(await prisma.oAuthAccount.count({ where: { userId: existing.id } }), 0);
    assert.equal(await prisma.user.count(), 1);
  });

  test("קישור מאובטח: רק עם כוונת קישור; הנתונים הקיימים נשמרים; sub אחד למשתמש אחד", async () => {
    const u1 = await prisma.user.create({ data: { name: "א", email: "a@example.com", passwordHash: "h", status: "APPROVED", firstName: "א" } });
    const u2 = await prisma.user.create({ data: { name: "ב", email: "b@example.com", passwordHash: "h" } });
    const r = await resolve(ident("s4", "other@gmail.com"), u1.id);
    assert.deepEqual(r, { ok: true, userId: u1.id });
    const after1 = await prisma.user.findUniqueOrThrow({ where: { id: u1.id } });
    assert.deepEqual([after1.status, after1.passwordHash], ["APPROVED", "h"]);
    // כניסה חוזרת ללא כוונת קישור -> אותו משתמש
    assert.deepEqual(await resolve(ident("s4", "other@gmail.com")), { ok: true, userId: u1.id });
    // אותו חשבון Google למשתמש אחר — נדחה
    assert.deepEqual(await resolve(ident("s4", "other@gmail.com"), u2.id), { ok: false, error: "google_already_linked" });
    // חשבון Google שני לאותו משתמש — נדחה
    assert.deepEqual(await resolve(ident("s5", "z@gmail.com"), u1.id), { ok: false, error: "google_already_linked" });
  });

  test("קישורים מקבילים של אותו sub לשני משתמשים: רק אחד מצליח", async () => {
    const u1 = await prisma.user.create({ data: { name: "א", email: "a@example.com", passwordHash: "h" } });
    const u2 = await prisma.user.create({ data: { name: "ב", email: "b@example.com", passwordHash: "h" } });
    const rs = await Promise.all([resolve(ident("s6", "q@gmail.com"), u1.id), resolve(ident("s6", "q@gmail.com"), u2.id)]);
    assert.equal(rs.filter((r) => r.ok).length, 1);
    assert.equal(await prisma.oAuthAccount.count(), 1);
  });

  test("מנהל לא ניתן לקישור, וגם לא להתחברות דרך Google", async () => {
    const admin = await prisma.user.create({ data: { name: "מנהל", email: "admin@example.com", passwordHash: "h", role: "ADMIN" } });
    assert.deepEqual(await resolve(ident("s7", "admin@example.com"), admin.id), { ok: false, error: "google_link_denied" });
    assert.deepEqual(await resolve(ident("s8", "admin@example.com")), { ok: false, error: "google_email_exists" });
    await prisma.oAuthAccount.create({ data: { provider: "google", providerAccountId: "s9", userId: admin.id } });
    assert.deepEqual(await resolve(ident("s9", "admin@example.com")), { ok: false, error: "google_link_denied" });
  });

  test("סיסמה זמנית (mustChangePassword) חוסמת קישור; חשבון Google בלבד לא עובר אימות סיסמה", async () => {
    const u = await prisma.user.create({ data: { name: "ת", email: "t@example.com", passwordHash: "h", mustChangePassword: true } });
    assert.deepEqual(await resolve(ident("s10", "t@example.com"), u.id), { ok: false, error: "google_link_denied" });
    assert.equal(await pw.verifyPassword("anything", null), false);
    assert.equal(await pw.verifyPassword("", null), false);
  });

  test("חסום/ממתין: ההתחברות מחזירה את אותו משתמש בלי לשנות סטטוס (המסכים הקיימים אוכפים)", async () => {
    const r = await resolve(ident("s11", "blk@example.com"));
    assert.ok(r.ok);
    await prisma.user.update({ where: { id: r.ok ? r.userId : "" }, data: { status: "BLOCKED" } });
    assert.ok((await resolve(ident("s11", "blk@example.com"))).ok);
    assert.equal((await prisma.user.findFirstOrThrow()).status, "BLOCKED");
  });
});
