-- Persisted recipient-domain for indexed per-domain pacing. Additive + relaxing
-- (nullable column, no read depends on non-null). Replaces the previous full-day
-- in-memory tally (campaign) and unindexed toEmail endsWith scan (follow-up).

ALTER TABLE "OutreachSent" ADD COLUMN "toEmailDomain" TEXT;

-- Backfill existing rows from toEmail (lowercased part after the '@'). Cheap single
-- UPDATE, no table rewrite; legacy malformed rows simply get an inert value that
-- never matches a real recipient domain. Only today's window matters functionally.
UPDATE "OutreachSent"
SET "toEmailDomain" = lower(split_part("toEmail", '@', 2))
WHERE "toEmailDomain" IS NULL AND position('@' in "toEmail") > 0;

CREATE INDEX "OutreachSent_workspaceId_toEmailDomain_status_sentAt_idx"
  ON "OutreachSent"("workspaceId", "toEmailDomain", "status", "sentAt");
