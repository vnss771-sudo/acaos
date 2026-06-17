-- Stage 1 of the intelligence-spine bridge. OutreachIntent links a
-- Recommendation (prospect-intelligence track) to draft/approval/send (outreach
-- track). Additive: new enum + table only — nothing existing changes.

CREATE TYPE "OutreachIntentStatus" AS ENUM ('PROPOSED','DRAFTED','APPROVED','QUEUED','SENT','WON','LOST','REJECTED');

CREATE TABLE "OutreachIntent" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "prospectId"       TEXT NOT NULL,
  "recommendationId" TEXT,
  "leadId"           TEXT,
  "campaignId"       TEXT,
  "missionId"        TEXT,
  "status"           "OutreachIntentStatus" NOT NULL DEFAULT 'PROPOSED',
  "messageAngle"     TEXT,
  "channel"          TEXT,
  "evidenceSnapshot" JSONB,
  "approvedBy"       TEXT,
  "approvedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutreachIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutreachIntent_recommendationId_key" ON "OutreachIntent"("recommendationId");
CREATE INDEX "OutreachIntent_workspaceId_status_idx" ON "OutreachIntent"("workspaceId", "status");
CREATE INDEX "OutreachIntent_prospectId_idx" ON "OutreachIntent"("prospectId");

ALTER TABLE "OutreachIntent" ADD CONSTRAINT "OutreachIntent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachIntent" ADD CONSTRAINT "OutreachIntent_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachIntent" ADD CONSTRAINT "OutreachIntent_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
