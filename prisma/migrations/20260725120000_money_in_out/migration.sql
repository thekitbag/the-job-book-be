-- CreateEnum
CREATE TYPE "JobMoneyDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "JobMoneyKind" AS ENUM ('REFUND', 'COST_PAID');

-- CreateTable
CREATE TABLE "job_money_events" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "direction" "JobMoneyDirection" NOT NULL,
    "kind" "JobMoneyKind" NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "sourceMemoryItemId" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_money_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_money_events_jobId_occurredAt_idx" ON "job_money_events"("jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "job_money_events_jobId_isDeleted_idx" ON "job_money_events"("jobId", "isDeleted");

-- CreateIndex
CREATE INDEX "job_money_events_jobId_sourceMemoryItemId_idx" ON "job_money_events"("jobId", "sourceMemoryItemId");

-- Partial unique index (raw SQL — not representable in schema.prisma): at most
-- one ACTIVE money event per (job, source item, kind). Guards against duplicate
-- mark-paid (COST_PAID) and duplicate refund (REFUND) events for the same source
-- item, including the race where two requests commit concurrently. Soft-deleted
-- rows are excluded so a corrected event can be re-created.
CREATE UNIQUE INDEX "job_money_events_active_source_kind_key" ON "job_money_events"("jobId", "sourceMemoryItemId", "kind") WHERE "isDeleted" = false;

-- AddForeignKey
ALTER TABLE "job_money_events" ADD CONSTRAINT "job_money_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
