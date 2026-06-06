-- Add ingest API key to Workspace (for autonomous lead gen system auth)
ALTER TABLE "Workspace" ADD COLUMN "ingestApiKey" TEXT;
CREATE UNIQUE INDEX "Workspace_ingestApiKey_key" ON "Workspace"("ingestApiKey");

-- Add source tracking to Lead
ALTER TABLE "Lead" ADD COLUMN "sourceTag" TEXT;

-- Add composite index for email deduplication queries
CREATE INDEX "Lead_workspaceId_email_idx" ON "Lead"("workspaceId", "email");
