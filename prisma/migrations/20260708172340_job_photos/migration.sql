-- CreateTable
CREATE TABLE "job_photos" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "descriptor" TEXT,
    "storageKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "linkedNoteId" TEXT,
    "linkedMemoryItemId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_photos_storageKey_key" ON "job_photos"("storageKey");

-- CreateIndex
CREATE INDEX "job_photos_jobId_uploadedAt_idx" ON "job_photos"("jobId", "uploadedAt");

-- CreateIndex
CREATE INDEX "job_photos_jobId_linkedNoteId_idx" ON "job_photos"("jobId", "linkedNoteId");

-- CreateIndex
CREATE INDEX "job_photos_jobId_linkedMemoryItemId_idx" ON "job_photos"("jobId", "linkedMemoryItemId");

-- AddForeignKey
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_linkedNoteId_fkey" FOREIGN KEY ("linkedNoteId") REFERENCES "raw_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_linkedMemoryItemId_fkey" FOREIGN KEY ("linkedMemoryItemId") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
