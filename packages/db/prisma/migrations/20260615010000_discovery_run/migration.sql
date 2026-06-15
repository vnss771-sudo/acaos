-- DiscoveryRun: audit log for prospect-discovery runs.
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "query" JSONB,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DiscoveryRun_workspaceId_startedAt_idx" ON "DiscoveryRun"("workspaceId", "startedAt");
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
