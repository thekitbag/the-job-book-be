-- AlterEnum
ALTER TYPE "FactType" ADD VALUE 'RETURNED_MATERIAL';

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "refundAmount" TEXT,
ADD COLUMN     "refundCurrency" TEXT,
ADD COLUMN     "returnedFromMemoryItemId" TEXT;
