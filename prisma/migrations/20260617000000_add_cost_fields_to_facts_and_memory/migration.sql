-- Add cost fields to candidate_facts
ALTER TABLE "candidate_facts" ADD COLUMN "costAmount" TEXT;
ALTER TABLE "candidate_facts" ADD COLUMN "costCurrency" TEXT;
ALTER TABLE "candidate_facts" ADD COLUMN "costQualifier" TEXT;
ALTER TABLE "candidate_facts" ADD COLUMN "totalCostAmount" TEXT;

-- Add cost fields to memory_items
ALTER TABLE "memory_items" ADD COLUMN "costAmount" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "costCurrency" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "costQualifier" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "totalCostAmount" TEXT;
