-- Learning recommendations: learning proposes, humans approve. Additive only.
CREATE TABLE "LearningRecommendation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "currentValue" JSONB,
    "proposedValue" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    CONSTRAINT "LearningRecommendation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LearningRecommendation_workspaceId_status_idx" ON "LearningRecommendation"("workspaceId", "status");
ALTER TABLE "LearningRecommendation" ADD CONSTRAINT "LearningRecommendation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- At most one PENDING recommendation per (workspace, type): concurrent
-- calibration runs can't both leave a pending proposal (processors.ts relies on it).
CREATE UNIQUE INDEX "LearningRecommendation_one_pending_per_type"
  ON "LearningRecommendation" ("workspaceId", "type")
  WHERE "status" = 'PENDING';
