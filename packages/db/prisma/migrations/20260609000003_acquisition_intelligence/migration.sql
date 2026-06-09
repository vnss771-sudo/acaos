-- Acquisition Intelligence Engine schema additions

-- Layer 5-7: new score dimensions on Prospect
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "similarityScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "channelScore" INTEGER NOT NULL DEFAULT 0;

-- Layer 9: learned signal weights on ScoringModel
ALTER TABLE "ScoringModel" ADD COLUMN IF NOT EXISTS "signalWeights" JSONB;

-- Layer 6: Workspace ICP configuration
CREATE TABLE IF NOT EXISTS "WorkspaceICP" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "targetIndustries" TEXT[] NOT NULL DEFAULT '{}',
  "minEmployees"     INTEGER,
  "maxEmployees"     INTEGER,
  "targetGeos"       TEXT[] NOT NULL DEFAULT '{}',
  "mustHaveEmail"    BOOLEAN NOT NULL DEFAULT false,
  "autoUpdatedAt"    TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceICP_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceICP_workspaceId_key" ON "WorkspaceICP"("workspaceId");
ALTER TABLE "WorkspaceICP" ADD CONSTRAINT "WorkspaceICP_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Security audit trail
CREATE TABLE IF NOT EXISTS "SecurityEvent" (
  "id"           TEXT NOT NULL,
  "eventType"    TEXT NOT NULL,
  "severity"     TEXT NOT NULL DEFAULT 'INFO',
  "userId"       TEXT,
  "workspaceId"  TEXT,
  "ipAddress"    TEXT,
  "userAgent"    TEXT,
  "resourceType" TEXT,
  "resourceId"   TEXT,
  "meta"         JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SecurityEvent_workspaceId_idx" ON "SecurityEvent"("workspaceId");
CREATE INDEX IF NOT EXISTS "SecurityEvent_eventType_idx" ON "SecurityEvent"("eventType");
CREATE INDEX IF NOT EXISTS "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
