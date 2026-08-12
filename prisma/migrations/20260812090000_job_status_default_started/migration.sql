-- A new job defaults to STARTED (user-facing "In progress"), matching the API
-- create default. Column default only: this changes nothing about rows that
-- already exist, so no job is reclassified — jobs currently PLANNING stay
-- PLANNING. Planning remains a state Mike chooses, never one he lands in by
-- omission.
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'STARTED';
