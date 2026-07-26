-- gen_random_uuid() is core in PG13+, but pgcrypto also provides it — ensure it
-- exists so the backfill below can mint LabourPerson ids in SQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "LabourBudgetTreatment" AS ENUM ('COUNTS_TOWARD_BUDGET', 'HOURS_ONLY');

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "labourPersonId" TEXT,
ADD COLUMN     "labourBudgetEnabled" BOOLEAN;

-- CreateTable
CREATE TABLE "labour_people" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "defaultHourlyRateAmount" TEXT,
    "defaultHourlyRateCurrency" TEXT,
    "defaultBudgetTreatment" "LabourBudgetTreatment" NOT NULL DEFAULT 'HOURS_ONLY',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labour_people_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "labour_people_ownerUserId_normalizedName_idx" ON "labour_people"("ownerUserId", "normalizedName");

-- CreateIndex
CREATE INDEX "labour_people_ownerUserId_isArchived_idx" ON "labour_people"("ownerUserId", "isArchived");

-- AddForeignKey
ALTER TABLE "labour_people" ADD CONSTRAINT "labour_people_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique index (raw SQL — not representable in schema.prisma): at most one
-- ACTIVE labour person per (owner, normalized name). Archived rows are excluded so
-- a name can be re-added after archiving.
CREATE UNIQUE INDEX "labour_people_active_name_key" ON "labour_people"("ownerUserId", "normalizedName") WHERE "isArchived" = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Data backfill: additive and total-preserving. Existing labour keeps its exact
-- current Budget effect; only visible per-entry defaults are added.
-- ─────────────────────────────────────────────────────────────────────────────

-- (A) Set labourBudgetEnabled on every LABOUR entry to EXACTLY reproduce the
-- current Budget classifier's "included" rule for labour, so budget-summary
-- totals are unchanged: active, no unresolved flags, a stored GBP totalCostAmount.
-- Everything else (hours-only, no-rate, non-GBP, worth-checking, removed) → false.
UPDATE "memory_items"
SET "labourBudgetEnabled" = (
  "isRemoved" = false
  AND cardinality("unresolvedFlags") = 0
  AND "totalCostAmount" IS NOT NULL
  AND "totalCostAmount" <> ''
  AND "costCurrency" = 'GBP'
)
WHERE "memoryType" = 'LABOUR';

-- (B) Create one active LabourPerson per (owning user, normalized name) from the
-- distinct non-blank labourPerson names on active labour entries. Display name is
-- the earliest-seen spelling. Default treatment is COUNTS_TOWARD_BUDGET when any
-- of that person's existing entries is budget-enabled (from step A), else HOURS_ONLY.
INSERT INTO "labour_people"
  ("id", "ownerUserId", "name", "normalizedName", "defaultBudgetTreatment", "isArchived", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  grp.owner_id,
  grp.display_name,
  grp.norm,
  grp.treatment,
  false,
  now(),
  now()
FROM (
  SELECT
    j."ownerUserId" AS owner_id,
    lower(btrim(mi."labourPerson")) AS norm,
    (array_agg(mi."labourPerson" ORDER BY mi."createdAt"))[1] AS display_name,
    CASE WHEN bool_or(COALESCE(mi."labourBudgetEnabled", false))
      THEN 'COUNTS_TOWARD_BUDGET'::"LabourBudgetTreatment"
      ELSE 'HOURS_ONLY'::"LabourBudgetTreatment"
    END AS treatment
  FROM "memory_items" mi
  JOIN "jobs" j ON j."id" = mi."jobId"
  WHERE mi."memoryType" = 'LABOUR'
    AND mi."isRemoved" = false
    AND mi."labourPerson" IS NOT NULL
    AND btrim(mi."labourPerson") <> ''
  GROUP BY j."ownerUserId", lower(btrim(mi."labourPerson"))
) grp;

-- (C) Link existing active labour entries to their matching person (same owner +
-- normalized name). Hours, dates, tasks, cost fields, and source evidence are
-- untouched.
UPDATE "memory_items" mi
SET "labourPersonId" = lp."id"
FROM "labour_people" lp, "jobs" j
WHERE j."id" = mi."jobId"
  AND lp."ownerUserId" = j."ownerUserId"
  AND lp."normalizedName" = lower(btrim(mi."labourPerson"))
  AND mi."memoryType" = 'LABOUR'
  AND mi."isRemoved" = false
  AND mi."labourPerson" IS NOT NULL
  AND btrim(mi."labourPerson") <> '';

-- (D) Infer a person's default hourly rate only when it is unambiguous: exactly
-- one distinct strict-positive GBP per_hour rate across that person's linked
-- entries. Otherwise leave the default rate null.
UPDATE "labour_people" lp
SET "defaultHourlyRateAmount" = r.rate,
    "defaultHourlyRateCurrency" = 'GBP'
FROM (
  SELECT
    mi."labourPersonId" AS pid,
    (array_agg(DISTINCT mi."costAmount"))[1] AS rate,
    count(DISTINCT mi."costAmount") AS distinct_rates
  FROM "memory_items" mi
  WHERE mi."labourPersonId" IS NOT NULL
    AND mi."costQualifier" = 'per_hour'
    AND mi."costCurrency" = 'GBP'
    AND mi."costAmount" ~ '^[0-9]+(\.[0-9]+)?$'
    AND mi."costAmount"::numeric > 0
  GROUP BY mi."labourPersonId"
) r
WHERE lp."id" = r.pid
  AND r.distinct_rates = 1;
