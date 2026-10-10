-- Job variations (UQ-35): scope changes beside the accepted quote, never over it.
CREATE TABLE "JobVariation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "revenueCents" INTEGER,
    "estimatedCostCents" INTEGER,
    "estimatedHours" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobVariation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobVariation_workspaceId_jobId_idx" ON "JobVariation"("workspaceId", "jobId");

ALTER TABLE "JobVariation" ADD CONSTRAINT "JobVariation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobVariation" ADD CONSTRAINT "JobVariation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cost and hours estimates are never negative; a price change may be (scope reduction).
ALTER TABLE "JobVariation" ADD CONSTRAINT "JobVariation_estimates_nonnegative" CHECK (("estimatedCostCents" IS NULL OR "estimatedCostCents" >= 0) AND ("estimatedHours" IS NULL OR "estimatedHours" >= 0));
ALTER TABLE "JobVariation" ADD CONSTRAINT "JobVariation_status_check" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'));
