-- Additive indexes; no data change.

-- Serves per-workspace deliverability counts that filter by status and a sentAt
-- window (campaign/mission stats and the send loop), replacing a workspace-wide
-- scan + in-memory filter.
CREATE INDEX "OutreachSent_workspaceId_status_sentAt_idx" ON "OutreachSent"("workspaceId", "status", "sentAt");

-- Serves the admin cross-workspace usage rollups that group/filter by month alone.
CREATE INDEX "UsageRecord_month_idx" ON "UsageRecord"("month");
