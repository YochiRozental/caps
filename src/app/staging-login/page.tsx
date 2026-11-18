import { LOGIN_API_PATH } from "@/lib/staging-gate/config";
import { safeInternalPath } from "@/lib/safe-path";
import { Alert } from "@/components/ui";

/**
 * עמוד הכניסה לשער ה-Staging. פטור מהשער עצמו (ראו isExemptPath). טופס HTML רגיל ללא JavaScript צד-לקוח,
 * כדי שיעבוד גם אם מודול הסשן של NextAuth נכשל לפני שהשער עצמו נפתח.
 */
export default async function StagingLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeInternalPath(params.next, "/");

  return (
    <div className="max-w-md mx-auto card p-8 mt-10">
      <h1 className="font-display text-2xl font-bold text-stone-900 mb-2">סביבת בדיקות</h1>
      <p className="text-sm text-stone-500 mb-6">סביבה זו סגורה לציבור. יש להזין את סיסמת הגישה כדי להמשיך.</p>

      <form method="POST" action={LOGIN_API_PATH} className="space-y-5">
        <input type="hidden" name="next" value={next} />
        <div>
          <label htmlFor="staging-password" className="field-label">
            סיסמת גישה
          </label>
          <input id="staging-password" name="password" required type="password" autoFocus className="field" />
        </div>

        {params.error === "1" && <Alert tone="error">סיסמה שגויה</Alert>}

        <button type="submit" className="btn btn-primary w-full py-3!">
          כניסה
        </button>
      </form>
    </div>
  );
}
