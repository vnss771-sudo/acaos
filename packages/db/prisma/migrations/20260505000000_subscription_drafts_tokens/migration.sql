-- Add subscription fields to Workspace
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");

-- Add phone and lastContactedAt to Lead
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "lastContactedAt" TIMESTAMP(3);

-- Add description to Campaign
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "description" TEXT;

-- Add createdAt to Membership
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add indexes on Lead
CREATE INDEX IF NOT EXISTS "Lead_workspaceId_idx" ON "Lead"("workspaceId");
CREATE INDEX IF NOT EXISTS "Lead_workspaceId_stage_idx" ON "Lead"("workspaceId", "stage");
CREATE INDEX IF NOT EXISTS "Lead_campaignId_idx" ON "Lead"("campaignId");

-- Add indexes on Campaign
CREATE INDEX IF NOT EXISTS "Campaign_workspaceId_idx" ON "Campaign"("workspaceId");

-- Add indexes on Membership
CREATE INDEX IF NOT EXISTS "Membership_userId_idx" ON "Membership"("userId");
CREATE INDEX IF NOT EXISTS "Membership_workspaceId_idx" ON "Membership"("workspaceId");

-- Create OutreachDraft table
CREATE TABLE IF NOT EXISTS "OutreachDraft" (
  "id"          TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subject"     TEXT NOT NULL,
  "emailBody"   TEXT NOT NULL,
  "followup"    TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "OutreachDraft_leadId_idx" ON "OutreachDraft"("leadId");
CREATE INDEX IF NOT EXISTS "OutreachDraft_workspaceId_idx" ON "OutreachDraft"("workspaceId");

-- Create RefreshToken table
CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");
