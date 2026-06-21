ALTER TABLE "memory_items" ADD COLUMN "unresolvedFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
