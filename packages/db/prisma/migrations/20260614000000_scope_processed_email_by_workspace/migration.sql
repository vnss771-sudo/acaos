-- ProcessedEmail.uid was globally unique but IMAP UIDs are only unique
-- within a single mailbox. Scope by workspaceId to prevent cross-workspace
-- dedup collisions where two workspaces have the same IMAP UID.

-- Drop the global unique constraints
DROP INDEX IF EXISTS "ProcessedEmail_uid_key";
DROP INDEX IF EXISTS "ProcessedEmail_messageId_key";

-- Add workspaceId column (nullable first so existing rows aren't rejected)
ALTER TABLE "ProcessedEmail" ADD COLUMN "workspaceId" TEXT;

-- Backfill: existing rows have no workspace context — assign a sentinel
-- that won't match any real workspace. They will be ignored during sync.
UPDATE "ProcessedEmail" SET "workspaceId" = 'legacy-unknown' WHERE "workspaceId" IS NULL;

-- Make the column required going forward
ALTER TABLE "ProcessedEmail" ALTER COLUMN "workspaceId" SET NOT NULL;

-- Add workspace FK
ALTER TABLE "ProcessedEmail"
  ADD CONSTRAINT "ProcessedEmail_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;

-- New compound unique constraints
CREATE UNIQUE INDEX "ProcessedEmail_workspaceId_uid_key" ON "ProcessedEmail"("workspaceId", "uid");
CREATE UNIQUE INDEX "ProcessedEmail_workspaceId_messageId_key" ON "ProcessedEmail"("workspaceId", "messageId");
CREATE INDEX "ProcessedEmail_workspaceId_idx" ON "ProcessedEmail"("workspaceId");
