-- Replace the job lifecycle: ACTIVE/COMPLETED/ARCHIVED (and any transient
-- PAUSED) become PLANNING/STARTED/FINISHED/ARCHIVED.
-- Data mapping: ACTIVE → STARTED, COMPLETED → FINISHED, ARCHIVED → ARCHIVED,
-- PAUSED (never shipped; local-only) → PLANNING.
-- The CASE compares text values so this applies cleanly whether or not the
-- old enum ever contained PAUSED.

CREATE TYPE "JobStatus_new" AS ENUM ('PLANNING', 'STARTED', 'FINISHED', 'ARCHIVED');

ALTER TABLE "jobs" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "jobs" ALTER COLUMN "status" TYPE "JobStatus_new"
  USING (
    CASE "status"::text
      WHEN 'ACTIVE' THEN 'STARTED'
      WHEN 'COMPLETED' THEN 'FINISHED'
      WHEN 'ARCHIVED' THEN 'ARCHIVED'
      WHEN 'PAUSED' THEN 'PLANNING'
      ELSE 'STARTED'
    END
  )::"JobStatus_new";

DROP TYPE "JobStatus";
ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";

ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'STARTED';
