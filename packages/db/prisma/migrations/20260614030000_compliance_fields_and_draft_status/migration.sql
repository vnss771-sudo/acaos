-- Add CAN-SPAM/GDPR compliance fields to Workspace
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "senderBusinessName" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "senderPostalAddress" TEXT;

-- Add approval workflow status to OutreachDraft
ALTER TABLE "OutreachDraft" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DRAFTED';
ALTER TABLE "OutreachDraft" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "OutreachDraft" ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;

-- Index for approval queue (pending review)
CREATE INDEX IF NOT EXISTS "OutreachDraft_workspaceId_status_idx" ON "OutreachDraft"("workspaceId", "status");
