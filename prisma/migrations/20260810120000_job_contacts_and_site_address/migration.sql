-- Job contacts and one job-level site address.
-- Contacts are job-local context (not global/reusable), soft-deleted so a
-- removal stays auditable. siteAddress is additive and nullable: existing
-- roughLocationOrLabel values are left untouched and never promoted.
ALTER TABLE "jobs" ADD COLUMN "siteAddress" TEXT;

CREATE TABLE "job_contacts" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_contacts_jobId_isDeleted_sortOrder_idx" ON "job_contacts"("jobId", "isDeleted", "sortOrder");

ALTER TABLE "job_contacts" ADD CONSTRAINT "job_contacts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_contacts" ADD CONSTRAINT "job_contacts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
