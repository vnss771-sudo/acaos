-- Rollback for 20261017000000_evidence_governance. Only safe while no deletion request
-- has ever executed (a COMPLETED request means evidence was irreversibly deleted and the
-- external ledger holds the record: do NOT discard that history). Also remove the
-- migration row from _prisma_migrations. Nothing here touches stored objects or the ledger.
DROP TABLE "EvidenceDeletionRequest";
ALTER TABLE "LegalHold" DROP COLUMN "releaseLedgeredAt";
ALTER TABLE "LegalHold" DROP COLUMN "ledgeredAt";
ALTER TABLE "RetentionPolicy" DROP CONSTRAINT "RetentionPolicy_pending_wait_check";
ALTER TABLE "RetentionPolicy" DROP CONSTRAINT "RetentionPolicy_wait_days_check";
ALTER TABLE "RetentionPolicy" DROP COLUMN "requireDistinctReviewer";
ALTER TABLE "RetentionPolicy" DROP COLUMN "pendingWaitRequestedBy";
ALTER TABLE "RetentionPolicy" DROP COLUMN "pendingWaitRequestedAt";
ALTER TABLE "RetentionPolicy" DROP COLUMN "pendingWaitDays";
ALTER TABLE "RetentionPolicy" DROP COLUMN "deletionWaitDays";
