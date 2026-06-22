-- Per-campaign per-day funnel counters: a fast read-model for dashboards so they
-- don't aggregate the whole send history. Live-incremented in the SENT/REPLIED
-- transactions and fully reconstructable from the ContactEvent ledger. Additive:
-- a new table only.

CREATE TABLE "CampaignDailyStats" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "campaignId"   TEXT NOT NULL,
  "date"         TIMESTAMP(3) NOT NULL,
  "sent"         INTEGER NOT NULL DEFAULT 0,
  "replied"      INTEGER NOT NULL DEFAULT 0,
  "interested"   INTEGER NOT NULL DEFAULT 0,
  "bounced"      INTEGER NOT NULL DEFAULT 0,
  "unsubscribed" INTEGER NOT NULL DEFAULT 0,
  "failed"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignDailyStats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignDailyStats_campaignId_date_key" ON "CampaignDailyStats"("campaignId", "date");
CREATE INDEX "CampaignDailyStats_workspaceId_date_idx" ON "CampaignDailyStats"("workspaceId", "date");

ALTER TABLE "CampaignDailyStats"
  ADD CONSTRAINT "CampaignDailyStats_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDailyStats"
  ADD CONSTRAINT "CampaignDailyStats_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
