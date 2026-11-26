import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

const schema = z.object({ newPassword: z.string().min(4, "הסיסמה חייבת להכיל לפחות 4 תווים") });

/** הגדרת סיסמת אתר לחשבון שנוצר דרך Google (passwordHash=null). חשבון עם סיסמה קיימת משנה אותה רק במסלול ההחלפה הרגיל */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });

  const hash = await hashPassword(parsed.data.newPassword);
  // תנאי passwordHash=null בעדכון עצמו: אטומי, ולא ניתן לדרוס סיסמה קיימת גם בבקשות מקבילות
  const { count } = await prisma.user.updateMany({
    where: { id: session.user.id, role: "CLIENT", passwordHash: null },
    data: { passwordHash: hash },
  });
  if (count === 0) return NextResponse.json({ error: "לחשבון כבר מוגדרת סיסמה" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
