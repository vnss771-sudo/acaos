-- AddIndex: optimize Inbox list query (GET /api/inbox)
-- Filters by (workspaceId, status='REPLIED') and orders by repliedAt DESC
-- This compound index covers the full query pattern without table scans
CREATE INDEX "OutreachSent_workspaceId_status_repliedAt_idx" ON "OutreachSent"("workspaceId", "status", "repliedAt");
