-- AlterEnum
ALTER TYPE "FactType" ADD VALUE 'LABOUR';

-- AlterTable
ALTER TABLE "candidate_facts" ADD COLUMN     "labourHours" TEXT,
ADD COLUMN     "labourPerson" TEXT,
ADD COLUMN     "labourTask" TEXT;

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "labourHours" TEXT,
ADD COLUMN     "labourPerson" TEXT,
ADD COLUMN     "labourTask" TEXT;
