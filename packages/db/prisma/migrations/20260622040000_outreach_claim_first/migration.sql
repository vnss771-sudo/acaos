-- Claim-first send correctness. The outbox row is now CLAIMED (the unique
-- (campaignId, leadId) slot reserved) BEFORE the draft copy is generated, so a
-- racing send job loses the claim before spending AI quota — no duplicate AI
-- spend, no duplicate draft. Three changes, all additive/relaxing:
--   * subject/body become nullable (unknown at claim time, filled once prepared)
--   * claimedAt: authoritative reservation timestamp (stable; sentAt can be
--     overwritten with the real SMTP-accept time on SENT)
--   * failedAt: when SMTP definitively rejected the send
-- Existing rows are backfilled from sentAt so history stays coherent.

ALTER TABLE "OutreachSent" ALTER COLUMN "subject" DROP NOT NULL;
ALTER TABLE "OutreachSent" ALTER COLUMN "body" DROP NOT NULL;

ALTER TABLE "OutreachSent" ADD COLUMN "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "OutreachSent" ADD COLUMN "failedAt" TIMESTAMP(3);

-- Backfill: historical rows claimed at (approximately) their sentAt; FAILED rows
-- failed at their sentAt.
UPDATE "OutreachSent" SET "claimedAt" = "sentAt";
UPDATE "OutreachSent" SET "failedAt" = "sentAt" WHERE "status" = 'FAILED';
