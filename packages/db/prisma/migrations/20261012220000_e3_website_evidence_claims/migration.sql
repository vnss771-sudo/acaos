CREATE TABLE "WebsiteEvidenceClaim" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "prospectId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteEvidenceClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebsiteEvidenceClaim_workspaceId_prospectId_claimId_key" ON "WebsiteEvidenceClaim"("workspaceId", "prospectId", "claimId");
CREATE INDEX "WebsiteEvidenceClaim_workspaceId_expiresAt_idx" ON "WebsiteEvidenceClaim"("workspaceId", "expiresAt");
CREATE INDEX "WebsiteEvidenceClaim_workspaceId_prospectId_lastSeenAt_idx" ON "WebsiteEvidenceClaim"("workspaceId", "prospectId", "lastSeenAt");
ALTER TABLE "WebsiteEvidenceClaim" ADD CONSTRAINT "WebsiteEvidenceClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebsiteEvidenceClaim" ADD CONSTRAINT "WebsiteEvidenceClaim_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
