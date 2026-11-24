BEGIN;

CREATE TYPE "CaptureContext" AS ENUM ('HOME', 'JOB');
CREATE TYPE "ItemMoveKind" AS ENUM ('NOTE', 'PHOTO');
ALTER TYPE "ReviewDecisionAction" ADD VALUE 'NOTE_LOOKS_RIGHT';

ALTER TABLE "raw_notes"
  ADD COLUMN "ownerUserId" TEXT,
  ADD COLUMN "captureContext" "CaptureContext" NOT NULL DEFAULT 'JOB',
  ADD COLUMN "filedAt" TIMESTAMP(3),
  ALTER COLUMN "jobId" DROP NOT NULL;

UPDATE "raw_notes" AS n SET "ownerUserId" = j."ownerUserId", "filedAt" = n."createdAt"
FROM "jobs" AS j WHERE j."id" = n."jobId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "raw_notes" GROUP BY "ownerUserId", "clientNoteId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate raw note client IDs per owner. Resolve duplicates before deploying Record from Home.';
  END IF;
END $$;

ALTER TABLE "raw_notes" ALTER COLUMN "ownerUserId" SET NOT NULL;
ALTER TABLE "raw_notes" ADD CONSTRAINT "raw_notes_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "raw_notes_ownerUserId_clientNoteId_key" ON "raw_notes"("ownerUserId", "clientNoteId");
CREATE INDEX "raw_notes_ownerUserId_jobId_capturedAt_idx" ON "raw_notes"("ownerUserId", "jobId", "capturedAt");
CREATE INDEX "raw_notes_jobId_idx" ON "raw_notes"("jobId");
DROP INDEX "raw_notes_jobId_clientNoteId_key";

ALTER TABLE "job_photos"
  ADD COLUMN "captureContext" "CaptureContext" NOT NULL DEFAULT 'JOB',
  ADD COLUMN "filedAt" TIMESTAMP(3),
  ADD COLUMN "clientPhotoId" TEXT,
  ALTER COLUMN "jobId" DROP NOT NULL;
UPDATE "job_photos" SET "filedAt" = "createdAt";
CREATE UNIQUE INDEX "job_photos_uploadedByUserId_clientPhotoId_key" ON "job_photos"("uploadedByUserId", "clientPhotoId");
CREATE INDEX "job_photos_uploadedByUserId_jobId_uploadedAt_idx" ON "job_photos"("uploadedByUserId", "jobId", "uploadedAt");

CREATE TABLE "item_moves" (
  "id" TEXT PRIMARY KEY,
  "ownerUserId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" "ItemMoveKind" NOT NULL,
  "noteId" TEXT,
  "photoId" TEXT,
  "fromJobId" TEXT NOT NULL,
  "toJobId" TEXT NOT NULL,
  "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "item_moves_ownerUserId_movedAt_idx" ON "item_moves"("ownerUserId", "movedAt");

COMMIT;
