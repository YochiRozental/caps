import Link from "next/link";
import { BrandHeader, Icon, SectionTitle } from "@/components/ui";
import { TRIAL_DISCOUNT_PERCENT, formatAgorot, regularPriceAgorot } from "@/lib/payments/pricing";
import { getRegularPricing, hoursPackageOptions, workshopHoursPackageOptions } from "@/lib/payments/pricing-db";
import { listShiftWindows } from "@/lib/shifts/windows-db";
import { hhmm } from "@/lib/shifts/windows";

export const dynamic = "force-dynamic";
export const metadata = { title: "מחירון",
  alternates: { canonical: "/pricing" } };

export default async function PricingPage() {
  const [shiftWindowsAll, pricing] = await Promise.all([listShiftWindows({ activeOnly: true }), getRegularPricing()]);
  const shiftWindows = shiftWindowsAll.filter((w) => w.active);
  const packages = hoursPackageOptions(pricing);
  const workshopPackages = workshopHoursPackageOptions(pricing);
  const singleHourAgorot = regularPriceAgorot(60, pricing.hourlyAgorot);
  const workshopSingleHourAgorot = regularPriceAgorot(60, pricing.workshopHourlyAgorot);
  const trialAgorot = Math.round((singleHourAgorot * (100 - TRIAL_DISCOUNT_PERCENT)) / 100);

  return (
    <div className="max-w-5xl mx-auto">
      <BrandHeader
        eyebrow="מחירון"
        title="המחירים שלנו"
        subtitle="כל מסלולי התמחור של הקפסולה — משמרות קבועות, כרטיסיות שעות, הזמנה בודדת ושעת ניסיון במחיר השקה"
      >
        <Link href="/booking" className="btn btn-bronze">
          הזמנת קליניקה
          <Icon name="arrowLeft" className="w-4 h-4" />
        </Link>
      </BrandHeader>

      {/* משמרות קבועות */}
      <section className="mb-10">
        <SectionTitle index="1" hint="יום קבוע בחדר קבוע, פעם בשבוע — חיוב חודשי, התחייבות למינימום 3 חודשים">
          משמרות קבועות
        </SectionTitle>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>שעות המשמרת</th>
                  <th>מחיר לחודש</th>
                  <th>חדר סדנאות (לחודש)</th>
                </tr>
              </thead>
              <tbody>
                {shiftWindows.map((w) => (
                  <tr key={w.id}>
                    <td className="tabular-nums" dir="ltr">
                      {hhmm(w.startMinutes)}–{hhmm(w.endMinutes)}
                    </td>
                    <td className="tabular-nums">
                      <strong>{w.monthlyPriceAgorot / 100} ₪</strong>
                    </td>
                    <td className="tabular-nums">
                      <strong>{w.workshopMonthlyPriceAgorot / 100} ₪</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* כרטיסיות שעות */}
      <section className="mb-10">
        <SectionTitle index="2" hint="יתרת שעות לניצול גמיש, ללא התחייבות למשמרת קבועה">
          כרטיסיות שעות
        </SectionTitle>
        <div className="grid sm:grid-cols-3 gap-4">
          {packages.map((p) => (
            <div key={p.hours} className="card card-hover p-6 text-center">
              <p className="font-display text-lg font-bold text-stone-900">{p.hours} שעות</p>
              <p className="font-display text-3xl font-bold text-brand-700 mt-2 tabular-nums">{p.priceAgorot / 100} ₪</p>
            </div>
          ))}
        </div>
        <h3 className="font-display text-lg font-bold text-stone-900 mt-6 mb-3">כרטיסיות לחדר סדנאות</h3>
        <p className="text-sm text-stone-500 mb-3">כרטיסיית חדר סדנאות מנוצלת רק להזמנות בחדר סדנאות, וכרטיסייה רגילה אינה מנוצלת בו.</p>
        <div className="grid sm:grid-cols-3 gap-4" data-testid="workshop-packages">
          {workshopPackages.map((p) => (
            <div key={p.hours} className="card card-hover p-6 text-center">
              <p className="font-display text-lg font-bold text-stone-900">{p.hours} שעות</p>
              <p className="font-display text-3xl font-bold text-brand-700 mt-2 tabular-nums">{p.priceAgorot / 100} ₪</p>
            </div>
          ))}
        </div>
      </section>

      {/* הזמנה בודדת */}
      <section className="mb-10">
        <SectionTitle index="3" hint="הזמנת שעה בודדת, ללא רכישת כרטיסייה או משמרת">
          הזמנה בודדת
        </SectionTitle>
        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
          <div className="card p-6 flex items-center justify-between gap-4">
            <p className="font-display text-lg font-bold text-stone-900">שעה אחת</p>
            <p className="font-display text-2xl font-bold text-brand-700 tabular-nums">{singleHourAgorot / 100} ₪</p>
          </div>
          <div className="card p-6 flex items-center justify-between gap-4" data-testid="workshop-hour">
            <p className="font-display text-lg font-bold text-stone-900">שעה אחת בחדר סדנאות</p>
            <p className="font-display text-2xl font-bold text-brand-700 tabular-nums">{workshopSingleHourAgorot / 100} ₪</p>
          </div>
        </div>
      </section>

      {/* מבצע השקה */}
      <section>
        <SectionTitle index="4" hint="שעת ניסיון ראשונה במחיר מבצע">
          מבצע השקה — שעת ניסיון
        </SectionTitle>
        <div className="card p-6 sm:p-7 max-w-md ring-1 ring-bronze-200 relative overflow-hidden">
          <span aria-hidden="true" className="absolute top-0 inset-x-6 hairline-bronze" />
          <span className="badge bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 ring-1 ring-bronze-200">
            <Icon name="sparkle" className="w-3.5 h-3.5" />
            {TRIAL_DISCOUNT_PERCENT}% הנחה להתנסות הראשונה
          </span>
          <div className="mt-4 flex items-baseline gap-3">
            <span className="text-stone-400 line-through text-lg tabular-nums">{formatAgorot(singleHourAgorot)} ₪</span>
            <span className="font-display text-4xl font-bold text-brand-700 tabular-nums">{formatAgorot(trialAgorot)} ₪</span>
          </div>
          <p className="text-sm text-stone-500 mt-2">לשעת ניסיון ראשונה בלבד</p>
        </div>
      </section>
    </div>
  );
}
