-- Reply attribution: record which OutreachSent an inbound message matched and by
-- which method, so a reply updates exactly ONE send (matched by In-Reply-To →
-- messageId, with a conservative most-recent-send fallback) and operators can see
-- unmatched/ambiguous replies. Additive: nullable columns + one index.

ALTER TABLE "ProcessedEmail" ADD COLUMN "matchedOutreachSentId" TEXT;
ALTER TABLE "ProcessedEmail" ADD COLUMN "matchMethod" TEXT;

CREATE INDEX "ProcessedEmail_workspaceId_matchedOutreachSentId_idx" ON "ProcessedEmail"("workspaceId", "matchedOutreachSentId");
