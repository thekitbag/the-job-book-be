-- Supplier account settlement across jobs.
--
-- One aggregate named-supplier payment covering whole recorded costs on several
-- jobs. Each covered cost still gets its own COST_PAID money event (so Budget
-- paid-state and the existing partial unique index keep working unchanged); the
-- new supplierAccountPaymentId links those child markers to the one payment, and
-- job Money groups them into a single visible allocation row per job.

-- CreateTable
CREATE TABLE "supplier_account_payments" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_account_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_account_payments_ownerUserId_clientRequestId_key" ON "supplier_account_payments"("ownerUserId", "clientRequestId");

-- CreateIndex
CREATE INDEX "supplier_account_payments_ownerUserId_supplierName_paidAt_idx" ON "supplier_account_payments"("ownerUserId", "supplierName", "paidAt");

-- CreateIndex
CREATE INDEX "supplier_account_payments_ownerUserId_isDeleted_paidAt_idx" ON "supplier_account_payments"("ownerUserId", "isDeleted", "paidAt");

-- AddForeignKey
ALTER TABLE "supplier_account_payments" ADD CONSTRAINT "supplier_account_payments_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "job_money_events" ADD COLUMN "supplierAccountPaymentId" TEXT;

-- CreateIndex
CREATE INDEX "job_money_events_supplierAccountPaymentId_idx" ON "job_money_events"("supplierAccountPaymentId");

-- AddForeignKey
ALTER TABLE "job_money_events" ADD CONSTRAINT "job_money_events_supplierAccountPaymentId_fkey" FOREIGN KEY ("supplierAccountPaymentId") REFERENCES "supplier_account_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
