-- Job evidence classification: photos and receipts/invoices share job_photos.
-- Existing rows default to PHOTO/IMAGE, so no photo is reclassified.
CREATE TYPE "JobEvidenceKind" AS ENUM ('PHOTO', 'RECEIPT');
CREATE TYPE "JobEvidenceFileKind" AS ENUM ('IMAGE', 'PDF');

ALTER TABLE "job_photos"
  ADD COLUMN "kind" "JobEvidenceKind" NOT NULL DEFAULT 'PHOTO',
  ADD COLUMN "fileKind" "JobEvidenceFileKind" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "originalFileName" TEXT;

CREATE INDEX "job_photos_jobId_kind_isDeleted_idx" ON "job_photos"("jobId", "kind", "isDeleted");
