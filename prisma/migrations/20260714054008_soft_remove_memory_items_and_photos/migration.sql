-- AlterTable
ALTER TABLE "job_photos" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByUserId" TEXT,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "isRemoved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "removedByUserId" TEXT,
ADD COLUMN     "removedReason" TEXT;

-- CreateIndex
CREATE INDEX "job_photos_jobId_isDeleted_idx" ON "job_photos"("jobId", "isDeleted");

-- CreateIndex
CREATE INDEX "memory_items_jobId_isRemoved_idx" ON "memory_items"("jobId", "isRemoved");
