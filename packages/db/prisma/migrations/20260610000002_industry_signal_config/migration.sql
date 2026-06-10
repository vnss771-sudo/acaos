-- Database-backed industry signal weight matrix
CREATE TABLE "IndustrySignalConfig" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "industry"     TEXT NOT NULL,
  "signalBoosts" JSONB NOT NULL,
  "description"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IndustrySignalConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IndustrySignalConfig"
  ADD CONSTRAINT "IndustrySignalConfig_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "IndustrySignalConfig_workspaceId_industry_key"
  ON "IndustrySignalConfig"("workspaceId", "industry");
CREATE INDEX "IndustrySignalConfig_workspaceId_idx"
  ON "IndustrySignalConfig"("workspaceId");
