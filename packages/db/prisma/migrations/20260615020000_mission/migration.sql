-- First-class Mission entity, linked one-to-one to its execution Campaign.
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goalType" TEXT NOT NULL,
    "targetCustomer" TEXT,
    "offer" TEXT,
    "playbookId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "campaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Mission_campaignId_key" ON "Mission"("campaignId");
CREATE INDEX "Mission_workspaceId_status_idx" ON "Mission"("workspaceId", "status");
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
