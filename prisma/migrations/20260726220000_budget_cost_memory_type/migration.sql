-- AlterEnum
-- Adds a general Budget cost memory/fact type. Labour becomes hours-only; job
-- costs (labour cost, plant, hire, subcontractor, other non-material costs) are
-- captured as BUDGET_COST. No columns change: BUDGET_COST reuses the existing
-- memory_items cost fields.
ALTER TYPE "FactType" ADD VALUE 'BUDGET_COST';
