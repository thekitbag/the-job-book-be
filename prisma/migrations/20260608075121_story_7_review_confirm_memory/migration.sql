/*
  Warnings:

  - You are about to drop the column `confirmedBy` on the `review_decisions` table. All the data in the column will be lost.
  - Added the required column `action` to the `review_decisions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `decidedBy` to the `review_decisions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `jobId` to the `review_decisions` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ReviewDecisionAction" AS ENUM ('CONFIRM', 'CORRECT', 'REJECT', 'CONFIRM_SECTION', 'ADD_MISSING');

-- DropForeignKey
ALTER TABLE "review_decisions" DROP CONSTRAINT "review_decisions_confirmedBy_fkey";

-- AlterTable
ALTER TABLE "review_decisions" DROP COLUMN "confirmedBy",
ADD COLUMN     "action" "ReviewDecisionAction" NOT NULL,
ADD COLUMN     "candidateFactId" TEXT,
ADD COLUMN     "decidedBy" TEXT NOT NULL,
ADD COLUMN     "jobId" TEXT NOT NULL,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "sectionKey" TEXT;

-- CreateTable
CREATE TABLE "memory_items" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "reviewDecisionId" TEXT NOT NULL,
    "sourceCandidateFactId" TEXT,
    "memoryType" "FactType" NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT NOT NULL,
    "materialName" TEXT,
    "quantity" TEXT,
    "unit" TEXT,
    "supplierName" TEXT,
    "deliveryTiming" TEXT,
    "locationOrUse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_items_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_candidateFactId_fkey" FOREIGN KEY ("candidateFactId") REFERENCES "candidate_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_reviewDecisionId_fkey" FOREIGN KEY ("reviewDecisionId") REFERENCES "review_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_sourceCandidateFactId_fkey" FOREIGN KEY ("sourceCandidateFactId") REFERENCES "candidate_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
