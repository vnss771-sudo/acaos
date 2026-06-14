ALTER TABLE "Prospect" ADD COLUMN IF NOT EXISTS "domainKey" TEXT;
CREATE UNIQUE INDEX "Prospect_workspaceId_domainKey_key"
  ON "Prospect"("workspaceId", "domainKey")
  WHERE "domainKey" IS NOT NULL;
CREATE INDEX "Prospect_workspaceId_domainKey_idx"
  ON "Prospect"("workspaceId", "domainKey");
