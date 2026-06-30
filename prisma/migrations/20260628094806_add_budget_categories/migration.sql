-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "budgetCategoryId" TEXT;

-- CreateTable
CREATE TABLE "job_budget_categories" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "budgetAmount" TEXT,
    "budgetCurrency" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_budget_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_budget_categories_jobId_sortOrder_idx" ON "job_budget_categories"("jobId", "sortOrder");

-- CreateIndex
CREATE INDEX "memory_items_jobId_budgetCategoryId_idx" ON "memory_items"("jobId", "budgetCategoryId");

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_budgetCategoryId_fkey" FOREIGN KEY ("budgetCategoryId") REFERENCES "job_budget_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_budget_categories" ADD CONSTRAINT "job_budget_categories_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
