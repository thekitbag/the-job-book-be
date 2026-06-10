-- AlterTable
ALTER TABLE "review_decisions" ADD COLUMN     "sourceCandidateFactIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
