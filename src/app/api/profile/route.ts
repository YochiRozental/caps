import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  findIdentityConflict,
  normalizeIdNumber,
  normalizePhone,
  profileFieldSchemas as fields,
} from "@/lib/profile";

// השלמת פרטים להזמנה: כל השדות חובה. אין כאן פרטי אשראי: התשלום מתבצע בדף המאובטח של Grow בלבד.
// שדות כרטיס שנשלחים בידי לקוח ישן נזרקים ע"י הסכמה (z.object מסיר מפתחות לא מוכרים) ולא נשמרים.
const profileSchema = z.object({
  firstName: fields.firstName,
  lastName: fields.lastName,
  phone: fields.phone,
  idNumber: fields.idNumber,
  gender: fields.gender,
});

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) {
    return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  }

  const { firstName, lastName, phone, idNumber, gender } = parsed.data;

  const normalizedPhone = normalizePhone(phone);
  const normalizedId = normalizeIdNumber(idNumber);

  const conflict = await findIdentityConflict({ phone: normalizedPhone, idNumber: normalizedId }, user.id);
  if (conflict) {
    return NextResponse.json({ error: conflict }, { status: 409 });
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name: `${firstName} ${lastName}`,
        firstName,
        lastName,
        phone: normalizedPhone,
        idNumber: normalizedId,
        gender,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[profile] failed to update user:", error);
    return NextResponse.json({ error: "שגיאה בשמירת הפרטים, נסה שוב" }, { status: 500 });
  }
}
