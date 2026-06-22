-- Follow-up sequencing foundation (visible-but-disabled): sequence steps + durable
-- follow-up tasks, plus a per-campaign autoFollowupsEnabled flag (default false, so
-- nothing schedules until an operator opts in). Additive: new enum, columns, tables.

ALTER TABLE "Campaign" ADD COLUMN "autoFollowupsEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "FollowupTaskStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'BLOCKED', 'SENT', 'CANCELLED', 'FAILED');

CREATE TABLE "OutreachSequenceStep" (
  "id"         TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "stepNumber" INTEGER NOT NULL,
  "delayDays"  INTEGER NOT NULL,
  "subject"    TEXT,
  "body"       TEXT NOT NULL,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutreachSequenceStep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutreachSequenceStep_campaignId_stepNumber_key" ON "OutreachSequenceStep"("campaignId", "stepNumber");
CREATE INDEX "OutreachSequenceStep_campaignId_isActive_idx" ON "OutreachSequenceStep"("campaignId", "isActive");
ALTER TABLE "OutreachSequenceStep"
  ADD CONSTRAINT "OutreachSequenceStep_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FollowupTask" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "campaignId"      TEXT NOT NULL,
  "leadId"          TEXT NOT NULL,
  "outreachSentId"  TEXT,
  "stepNumber"      INTEGER NOT NULL,
  "status"          "FollowupTaskStatus" NOT NULL DEFAULT 'SCHEDULED',
  "scheduledFor"    TIMESTAMP(3) NOT NULL,
  "cancelledReason" TEXT,
  "lastError"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowupTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FollowupTask_campaignId_leadId_stepNumber_key" ON "FollowupTask"("campaignId", "leadId", "stepNumber");
CREATE INDEX "FollowupTask_workspaceId_status_scheduledFor_idx" ON "FollowupTask"("workspaceId", "status", "scheduledFor");
CREATE INDEX "FollowupTask_campaignId_status_idx" ON "FollowupTask"("campaignId", "status");
CREATE INDEX "FollowupTask_leadId_status_idx" ON "FollowupTask"("leadId", "status");
ALTER TABLE "FollowupTask"
  ADD CONSTRAINT "FollowupTask_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowupTask"
  ADD CONSTRAINT "FollowupTask_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowupTask"
  ADD CONSTRAINT "FollowupTask_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
