-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewDecisionAction" ADD VALUE 'QUEUE_CONFIRM';
ALTER TYPE "ReviewDecisionAction" ADD VALUE 'QUEUE_CORRECT';
ALTER TYPE "ReviewDecisionAction" ADD VALUE 'QUEUE_DISMISS';

-- CreateTable
CREATE TABLE "queue_items" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reviewLabel" TEXT NOT NULL,
    "timeLabel" TEXT,
    "summary" TEXT NOT NULL,
    "proposedMemory" JSONB NOT NULL,
    "confidenceLabel" TEXT NOT NULL DEFAULT 'medium',
    "uncertaintyFlags" TEXT[],
    "sourceCandidateFactIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "queue_items_jobId_idx" ON "queue_items"("jobId");

-- AddForeignKey
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
