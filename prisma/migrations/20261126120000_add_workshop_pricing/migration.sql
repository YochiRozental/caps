-- תמחור חדר סדנאות: כפול מהחדרים הרגילים (ברירת מחדל התחלתית; ניתן לעריכה ע"י מנהל). אינו משנה תשלומים/חבילות/משמרות קיימים.

-- RegularPricing: שעה בודדת וכרטיסיות. מוסיפים כעמודות ריקות, ממלאים 2x מהערכים הנוכחיים ואז הופכים ל-NOT NULL
ALTER TABLE "RegularPricing"
  ADD COLUMN "workshopHourlyAgorot" INTEGER,
  ADD COLUMN "workshopPackage5Agorot" INTEGER,
  ADD COLUMN "workshopPackage10Agorot" INTEGER,
  ADD COLUMN "workshopPackage20Agorot" INTEGER;
UPDATE "RegularPricing" SET
  "workshopHourlyAgorot" = "hourlyAgorot" * 2,
  "workshopPackage5Agorot" = "package5Agorot" * 2,
  "workshopPackage10Agorot" = "package10Agorot" * 2,
  "workshopPackage20Agorot" = "package20Agorot" * 2;
ALTER TABLE "RegularPricing"
  ALTER COLUMN "workshopHourlyAgorot" SET NOT NULL,
  ALTER COLUMN "workshopPackage5Agorot" SET NOT NULL,
  ALTER COLUMN "workshopPackage10Agorot" SET NOT NULL,
  ALTER COLUMN "workshopPackage20Agorot" SET NOT NULL;

-- ShiftWindow: מחיר חודשי לחדר סדנאות
ALTER TABLE "ShiftWindow" ADD COLUMN "workshopMonthlyPriceAgorot" INTEGER;
UPDATE "ShiftWindow" SET "workshopMonthlyPriceAgorot" = "monthlyPriceAgorot" * 2;
ALTER TABLE "ShiftWindow" ALTER COLUMN "workshopMonthlyPriceAgorot" SET NOT NULL;

-- כרטיסיות, זיכויים ותשלומי רכישה: סימון חדר סדנאות (קיימים = רגילים)
ALTER TABLE "HoursPackage" ADD COLUMN "workshop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Credit" ADD COLUMN "workshop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "packageWorkshop" BOOLEAN NOT NULL DEFAULT false;
