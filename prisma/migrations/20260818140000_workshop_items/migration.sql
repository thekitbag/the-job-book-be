-- Workshop: availability memory over real leftovers. Additive only — no
-- existing table is touched, so no purchase, cost, paid or job-status data can
-- move as part of this migration.

CREATE TYPE "WorkshopItemState" AS ENUM ('AVAILABLE', 'USED_UP', 'WASNT_THERE', 'MOVED_BACK');
CREATE TYPE "WorkshopItemSourceKind" AS ENUM ('LEFTOVER', 'MANUAL');

CREATE TABLE "workshop_items" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "roughAmount" TEXT,
    "sourceKind" "WorkshopItemSourceKind" NOT NULL,
    "sourceJobId" TEXT,
    "sourceMemoryItemId" TEXT,
    "state" "WorkshopItemState" NOT NULL DEFAULT 'AVAILABLE',
    "enteredWorkshopAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workshop_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workshop_items_ownerUserId_state_enteredWorkshopAt_idx" ON "workshop_items"("ownerUserId", "state", "enteredWorkshopAt");
CREATE INDEX "workshop_items_sourceJobId_sourceMemoryItemId_idx" ON "workshop_items"("sourceJobId", "sourceMemoryItemId");

-- The core invariant, enforced by the database rather than by a read-then-write:
-- at most ONE currently-available Workshop item per source leftover. Concurrent
-- duplicate moves therefore cannot both succeed. Terminal and moved-back rows
-- are excluded so the same source can be moved again after an undo or a
-- correction without a second availability record being created.
CREATE UNIQUE INDEX "workshop_items_one_available_per_source"
    ON "workshop_items"("sourceMemoryItemId")
    WHERE "state" = 'AVAILABLE' AND "sourceMemoryItemId" IS NOT NULL;

ALTER TABLE "workshop_items" ADD CONSTRAINT "workshop_items_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workshop_items" ADD CONSTRAINT "workshop_items_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workshop_items" ADD CONSTRAINT "workshop_items_sourceMemoryItemId_fkey" FOREIGN KEY ("sourceMemoryItemId") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
