-- CreateTable
CREATE TABLE "support_audit_events" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "targetJobId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_audit_events_adminUserId_createdAt_idx" ON "support_audit_events"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "support_audit_events_targetJobId_createdAt_idx" ON "support_audit_events"("targetJobId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_audit_events" ADD CONSTRAINT "support_audit_events_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
