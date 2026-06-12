-- Enforce lowercase-only role values — prevents 'OWNER' vs 'owner' mismatch
ALTER TABLE "Membership"
  ADD CONSTRAINT "Membership_role_check"
  CHECK (role IN ('owner', 'admin', 'member'));

-- Enforce known status values on cadence enrollments
ALTER TABLE "CadenceEnrollment"
  ADD CONSTRAINT "CadenceEnrollment_status_check"
  CHECK (status IN ('ACTIVE','PAUSED','COMPLETED','REPLIED','UNSUBSCRIBED','PENDING_REVIEW'));

-- Enforce known event types on engagement events
ALTER TABLE "EngagementEvent"
  ADD CONSTRAINT "EngagementEvent_eventType_check"
  CHECK ("eventType" IN ('OPENED','CLICKED','REPLIED','BOUNCED','UNSUBSCRIBED'));

-- Ensure OpportunityBrief array columns are never null (safe for pre-existing rows)
UPDATE "OpportunityBrief" SET "whyNow" = '{}' WHERE "whyNow" IS NULL;
UPDATE "OpportunityBrief" SET "rejectionReasons" = '{}' WHERE "rejectionReasons" IS NULL;
ALTER TABLE "OpportunityBrief" ALTER COLUMN "whyNow" SET NOT NULL;
ALTER TABLE "OpportunityBrief" ALTER COLUMN "whyNow" SET DEFAULT '{}';
ALTER TABLE "OpportunityBrief" ALTER COLUMN "rejectionReasons" SET NOT NULL;
ALTER TABLE "OpportunityBrief" ALTER COLUMN "rejectionReasons" SET DEFAULT '{}';

-- Partial index for active cadence enrollment polling (far faster than full composite index)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CadenceEnrollment_active_nextActionAt_idx"
  ON "CadenceEnrollment"("nextActionAt")
  WHERE status = 'ACTIVE';

-- Composite index for engagement event analytics queries
CREATE INDEX IF NOT EXISTS "EngagementEvent_workspaceId_sendId_idx"
  ON "EngagementEvent"("workspaceId", "sendId");

-- Composite index for recommendation expiry pruning
CREATE INDEX IF NOT EXISTS "Recommendation_workspaceId_expiresAt_idx"
  ON "Recommendation"("workspaceId", "expiresAt");
