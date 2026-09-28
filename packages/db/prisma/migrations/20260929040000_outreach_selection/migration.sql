-- Selection tracking for campaign runs. Additive only.
CREATE TABLE "OutreachSelectionRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "orderBy" TEXT NOT NULL,
    "icpFingerprint" TEXT NOT NULL,
    "modelFingerprint" TEXT NOT NULL,
    "totals" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "OutreachSelectionRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "OutreachSelection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "leadScore" INTEGER NOT NULL,
    "outreachSentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachSelection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutreachSelectionRun_workspaceId_startedAt_idx" ON "OutreachSelectionRun"("workspaceId", "startedAt");
CREATE INDEX "OutreachSelectionRun_campaignId_idx" ON "OutreachSelectionRun"("campaignId");
CREATE INDEX "OutreachSelection_workspaceId_runId_idx" ON "OutreachSelection"("workspaceId", "runId");
CREATE INDEX "OutreachSelection_leadId_idx" ON "OutreachSelection"("leadId");
ALTER TABLE "OutreachSelectionRun" ADD CONSTRAINT "OutreachSelectionRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachSelection" ADD CONSTRAINT "OutreachSelection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachSelection" ADD CONSTRAINT "OutreachSelection_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OutreachSelectionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
