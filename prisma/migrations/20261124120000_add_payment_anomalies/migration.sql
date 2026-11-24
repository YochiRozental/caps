-- חריגות תשלום (חיוב מרובה / תשלום אחרי ביטול / החזר אצל הספק) לטיפול ידני והתראה למנהלים. טבלה חדשה בלבד: אין שינוי בנתונים קיימים
-- CreateEnum
CREATE TYPE "PaymentAnomalyKind" AS ENUM ('MULTIPLE_PAID', 'PAID_AFTER_CANCEL', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentAnomalyStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "PaymentAnomaly" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "kind" "PaymentAnomalyKind" NOT NULL,
    "transactionIds" TEXT NOT NULL,
    "paidAgorot" INTEGER NOT NULL,
    "status" "PaymentAnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "alertAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastAlertAttemptAt" TIMESTAMP(3),
    "lastAlertError" TEXT,
    "alertSentAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAnomaly_status_createdAt_idx" ON "PaymentAnomaly"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAnomaly_paymentId_kind_transactionIds_key" ON "PaymentAnomaly"("paymentId", "kind", "transactionIds");

-- AddForeignKey
ALTER TABLE "PaymentAnomaly" ADD CONSTRAINT "PaymentAnomaly_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

