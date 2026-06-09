-- CreateEnum
CREATE TYPE "TidyUpItemKind" AS ENUM ('SINGLE', 'DUPLICATE_GROUP', 'CONTRADICTION', 'UNCLEAR_PROMPT');

-- CreateEnum
CREATE TYPE "TidyUpItemStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CORRECTED', 'REJECTED', 'LEFT_UNCONFIRMED');

-- CreateEnum
CREATE TYPE "TidyUpDecisionAction" AS ENUM ('CONFIRM', 'CORRECT', 'REJECT', 'LEAVE_UNCONFIRMED');

-- DropForeignKey
ALTER TABLE "memory_items" DROP CONSTRAINT "memory_items_reviewDecisionId_fkey";

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "tidyUpDecisionId" TEXT,
ALTER COLUMN "reviewDecisionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "tidy_up_runs" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tidy_up_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tidy_up_items" (
    "id" TEXT NOT NULL,
    "tidyUpRunId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "kind" "TidyUpItemKind" NOT NULL,
    "status" "TidyUpItemStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewLabel" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "proposedMemory" JSONB NOT NULL,
    "confidenceLabel" TEXT NOT NULL DEFAULT 'medium',
    "uncertaintyFlags" TEXT[],
    "sourceCandidateFactIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tidy_up_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tidy_up_decisions" (
    "id" TEXT NOT NULL,
    "tidyUpItemId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "action" "TidyUpDecisionAction" NOT NULL,
    "correctedFields" JSONB,
    "reason" TEXT,
    "memoryItemId" TEXT,
    "sourceCandidateFactIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tidy_up_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tidy_up_runs_jobId_localDate_idx" ON "tidy_up_runs"("jobId", "localDate");

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_reviewDecisionId_fkey" FOREIGN KEY ("reviewDecisionId") REFERENCES "review_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tidy_up_runs" ADD CONSTRAINT "tidy_up_runs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tidy_up_items" ADD CONSTRAINT "tidy_up_items_tidyUpRunId_fkey" FOREIGN KEY ("tidyUpRunId") REFERENCES "tidy_up_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tidy_up_items" ADD CONSTRAINT "tidy_up_items_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tidy_up_decisions" ADD CONSTRAINT "tidy_up_decisions_tidyUpItemId_fkey" FOREIGN KEY ("tidyUpItemId") REFERENCES "tidy_up_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tidy_up_decisions" ADD CONSTRAINT "tidy_up_decisions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tidy_up_decisions" ADD CONSTRAINT "tidy_up_decisions_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
