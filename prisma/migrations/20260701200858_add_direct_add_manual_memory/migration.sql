-- AlterEnum
ALTER TYPE "FactType" ADD VALUE 'GENERAL_NOTE';

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "happenedAt" TIMESTAMP(3);
