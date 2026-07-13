-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "customerTotalAmount" TEXT,
ADD COLUMN     "customerTotalCurrency" TEXT;

-- CreateTable
CREATE TABLE "job_payments" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_payments_jobId_paidAt_idx" ON "job_payments"("jobId", "paidAt");

-- CreateIndex
CREATE INDEX "job_payments_jobId_isDeleted_idx" ON "job_payments"("jobId", "isDeleted");

-- AddForeignKey
ALTER TABLE "job_payments" ADD CONSTRAINT "job_payments_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
