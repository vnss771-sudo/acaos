-- AlterTable
ALTER TABLE "WorkspaceICP" ALTER COLUMN "targetIndustries" DROP DEFAULT,
ALTER COLUMN "targetGeos" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ProcessedStripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("id")
);
