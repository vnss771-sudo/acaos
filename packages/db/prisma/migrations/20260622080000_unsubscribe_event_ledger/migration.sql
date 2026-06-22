-- Unsubscribe audit ledger: WHEN/HOW/from-which-send each opt-out happened, kept
-- separately from the Suppression list (current state) for compliance/reporting.
-- Additive: a new enum + table only.

CREATE TYPE "UnsubscribeSource" AS ENUM ('LINK', 'ONE_CLICK', 'MANUAL', 'COMPLAINT');

CREATE TABLE "UnsubscribeEvent" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "emailKey"       TEXT NOT NULL,
  "source"         "UnsubscribeSource" NOT NULL,
  "campaignId"     TEXT,
  "outreachSentId" TEXT,
  "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnsubscribeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UnsubscribeEvent_workspaceId_occurredAt_idx" ON "UnsubscribeEvent"("workspaceId", "occurredAt");
CREATE INDEX "UnsubscribeEvent_workspaceId_emailKey_idx" ON "UnsubscribeEvent"("workspaceId", "emailKey");

ALTER TABLE "UnsubscribeEvent"
  ADD CONSTRAINT "UnsubscribeEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
