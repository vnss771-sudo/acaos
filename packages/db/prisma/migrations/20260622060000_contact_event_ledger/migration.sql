-- Contact lifecycle ledger: the durable, append-only source of truth for
-- per-recipient outreach events (SENT/REPLIED/BOUNCED/UNSUBSCRIBED/FAILED) that
-- contact-policy, campaign stats, and forensic timelines read from. Additive: a
-- new table only. Scalar leadId/campaignId/outreachSentId (no FKs) so history
-- survives deletion of the referenced rows.

CREATE TABLE "ContactEvent" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "emailKey"       TEXT NOT NULL,
  "leadId"         TEXT,
  "campaignId"     TEXT,
  "outreachSentId" TEXT,
  "type"           TEXT NOT NULL,
  "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata"       JSONB,
  CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactEvent_workspaceId_emailKey_occurredAt_idx" ON "ContactEvent"("workspaceId", "emailKey", "occurredAt");
CREATE INDEX "ContactEvent_workspaceId_campaignId_occurredAt_idx" ON "ContactEvent"("workspaceId", "campaignId", "occurredAt");
CREATE INDEX "ContactEvent_outreachSentId_idx" ON "ContactEvent"("outreachSentId");

ALTER TABLE "ContactEvent"
  ADD CONSTRAINT "ContactEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
