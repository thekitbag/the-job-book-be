-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'EXTRACTING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FactType" AS ENUM ('ORDERED_MATERIAL', 'USED_MATERIAL', 'LEFTOVER_MATERIAL', 'SUPPLIER_DELIVERY_NOTE', 'CUSTOMER_CHANGE', 'WATCH_OUT', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "CandidateFactStatus" AS ENUM ('DRAFT', 'UNCLEAR', 'CONFIRMED', 'CORRECTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ConfidenceLabel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "extractionCompletedAt" TIMESTAMP(3),
ADD COLUMN     "extractionErrorCode" TEXT,
ADD COLUMN     "extractionErrorMessage" TEXT,
ADD COLUMN     "extractionModel" TEXT,
ADD COLUMN     "extractionProvider" TEXT,
ADD COLUMN     "extractionSchemaVersion" TEXT,
ADD COLUMN     "extractionStartedAt" TIMESTAMP(3),
ADD COLUMN     "extractionStatus" "ExtractionStatus";

-- CreateTable
CREATE TABLE "candidate_facts" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceNoteId" TEXT NOT NULL,
    "sourceTranscriptId" TEXT NOT NULL,
    "factType" "FactType" NOT NULL,
    "status" "CandidateFactStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL,
    "materialName" TEXT,
    "quantity" TEXT,
    "unit" TEXT,
    "supplierName" TEXT,
    "deliveryTiming" TEXT,
    "locationOrUse" TEXT,
    "confidenceLabel" "ConfidenceLabel" NOT NULL,
    "confidenceReason" TEXT NOT NULL,
    "uncertaintyFlags" TEXT[],
    "extractionProvider" TEXT,
    "extractionModel" TEXT,
    "extractionSchemaVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_facts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_sourceNoteId_fkey" FOREIGN KEY ("sourceNoteId") REFERENCES "raw_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_sourceTranscriptId_fkey" FOREIGN KEY ("sourceTranscriptId") REFERENCES "transcripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
