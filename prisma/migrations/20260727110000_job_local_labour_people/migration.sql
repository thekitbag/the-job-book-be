-- Labour people are local to a job. Preserve existing people and linked labour
-- entries by making one person copy per (old person, job) before replacing the
-- ownership column. The old Budget-treatment setting is deliberately discarded:
-- labour Budget inclusion is now determined by each trusted positive cost.
CREATE TEMP TABLE labour_person_job_map AS
SELECT
  lp."id" AS old_person_id,
  mi."jobId" AS job_id,
  gen_random_uuid()::text AS new_person_id
FROM "labour_people" lp
JOIN "memory_items" mi ON mi."labourPersonId" = lp."id"
GROUP BY lp."id", mi."jobId";

-- The prior user-wide active-name index must go before making one copy per job.
DROP INDEX IF EXISTS "labour_people_active_name_key";

INSERT INTO "labour_people" (
  "id", "ownerUserId", "name", "normalizedName", "defaultHourlyRateAmount",
  "defaultHourlyRateCurrency", "defaultBudgetTreatment", "isArchived", "createdAt", "updatedAt"
)
SELECT
  m.new_person_id, lp."ownerUserId", lp."name", lp."normalizedName",
  lp."defaultHourlyRateAmount", lp."defaultHourlyRateCurrency",
  lp."defaultBudgetTreatment", lp."isArchived", lp."createdAt", lp."updatedAt"
FROM labour_person_job_map m
JOIN "labour_people" lp ON lp."id" = m.old_person_id;

UPDATE "memory_items" mi
SET "labourPersonId" = m.new_person_id
FROM labour_person_job_map m
WHERE mi."labourPersonId" = m.old_person_id AND mi."jobId" = m.job_id;

-- Existing unlinked people had no job-local meaning, so archive/delete them
-- along with original source rows now that every referenced person has a copy.
DELETE FROM "labour_people"
WHERE "id" NOT IN (SELECT new_person_id FROM labour_person_job_map);

ALTER TABLE "labour_people" DROP CONSTRAINT "labour_people_ownerUserId_fkey";
DROP INDEX IF EXISTS "labour_people_ownerUserId_normalizedName_idx";
DROP INDEX IF EXISTS "labour_people_ownerUserId_isArchived_idx";
ALTER TABLE "labour_people" DROP COLUMN "ownerUserId";
ALTER TABLE "labour_people" DROP COLUMN "defaultBudgetTreatment";
ALTER TABLE "labour_people" ADD COLUMN "jobId" TEXT;

UPDATE "labour_people" lp
SET "jobId" = m.job_id
FROM labour_person_job_map m
WHERE lp."id" = m.new_person_id;

ALTER TABLE "labour_people" ALTER COLUMN "jobId" SET NOT NULL;
ALTER TABLE "labour_people" ADD CONSTRAINT "labour_people_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "labour_people_jobId_normalizedName_idx" ON "labour_people"("jobId", "normalizedName");
CREATE INDEX "labour_people_jobId_isArchived_idx" ON "labour_people"("jobId", "isArchived");
CREATE UNIQUE INDEX "labour_people_active_job_name_key"
  ON "labour_people"("jobId", "normalizedName") WHERE "isArchived" = false;

-- This is an internal legacy field only. Positive trusted labour now rolls up
-- without consulting it; retain the column for old rows/API compatibility.
UPDATE "memory_items"
SET "labourBudgetEnabled" = CASE
  WHEN "memoryType" = 'LABOUR'
   AND cardinality("unresolvedFlags") = 0
   AND "costCurrency" = 'GBP'
   AND "totalCostAmount" ~ '^[0-9]+(\\.[0-9]+)?$'
   AND "totalCostAmount"::numeric > 0
  THEN true
  ELSE false
END
WHERE "memoryType" = 'LABOUR';
