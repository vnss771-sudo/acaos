-- AlterTable: add webhookUrl to Workspace
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;

-- AlterTable: add workspaceId to ProcessedEmail and fix unique constraints
ALTER TABLE "ProcessedEmail" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "ProcessedEmail_uid_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ProcessedEmail_workspaceId_uid_key" ON "ProcessedEmail"("workspaceId", "uid");
CREATE INDEX IF NOT EXISTS "ProcessedEmail_workspaceId_idx" ON "ProcessedEmail"("workspaceId");

-- AlterTable Lead: add unique constraint on (workspaceId, email) for dedup
-- Only creates if no duplicates exist; if it fails, duplicates need resolving first
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'Lead' AND indexname = 'Lead_workspaceId_email_key'
  ) THEN
    -- Delete duplicate (workspaceId, email) pairs keeping the one with the highest score
    DELETE FROM "Lead" l1
    USING "Lead" l2
    WHERE l1.email IS NOT NULL
      AND l1.email = l2.email
      AND l1."workspaceId" = l2."workspaceId"
      AND l1.score < l2.score;
    CREATE UNIQUE INDEX "Lead_workspaceId_email_key" ON "Lead"("workspaceId", "email") WHERE "email" IS NOT NULL;
  END IF;
END $$;

-- Drop old non-unique index on (workspaceId, email) if it exists
DROP INDEX IF EXISTS "Lead_workspaceId_email_idx";

-- CreateTable: LeadActivity
CREATE TABLE IF NOT EXISTS "LeadActivity" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT,
  "type" TEXT NOT NULL,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadActivity_leadId_idx" ON "LeadActivity"("leadId");
CREATE INDEX IF NOT EXISTS "LeadActivity_workspaceId_idx" ON "LeadActivity"("workspaceId");
CREATE INDEX IF NOT EXISTS "LeadActivity_createdAt_idx" ON "LeadActivity"("createdAt");

ALTER TABLE "LeadActivity"
  DROP CONSTRAINT IF EXISTS "LeadActivity_leadId_fkey";
ALTER TABLE "LeadActivity"
  ADD CONSTRAINT "LeadActivity_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: WorkspaceInvite
CREATE TABLE IF NOT EXISTS "WorkspaceInvite" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "token" TEXT NOT NULL,
  "invitedById" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceInvite_token_key" ON "WorkspaceInvite"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceInvite_workspaceId_email_key" ON "WorkspaceInvite"("workspaceId", "email");
CREATE INDEX IF NOT EXISTS "WorkspaceInvite_workspaceId_idx" ON "WorkspaceInvite"("workspaceId");

ALTER TABLE "WorkspaceInvite"
  DROP CONSTRAINT IF EXISTS "WorkspaceInvite_workspaceId_fkey";
ALTER TABLE "WorkspaceInvite"
  ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
