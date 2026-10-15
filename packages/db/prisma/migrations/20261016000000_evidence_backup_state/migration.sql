-- C3: backup replication bookkeeping on EvidenceFileCopy. Additive only.
-- Rollback: docs/plans/C3_EVIDENCE_BACKUP_ROLLBACK.sql
ALTER TABLE "EvidenceFileCopy" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EvidenceFileCopy" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "EvidenceFileCopy" ADD COLUMN "lastError" TEXT;

-- A copy being verified (read back and hashed) is its own state.
ALTER TABLE "EvidenceFileCopy" DROP CONSTRAINT "EvidenceFileCopy_status_check";
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_status_check"
  CHECK ("status" IN ('PENDING', 'VERIFYING', 'VERIFIED', 'FAILED', 'DELETED'));
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_attempts_check"
  CHECK ("attempts" >= 0);
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_lastError_check"
  CHECK ("lastError" IS NULL OR length("lastError") <= 64);

-- The backup copy's key must be the same job-scoped key as the primary's.
-- Used by the backup worker only; the application also enforces it.
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_backup_key_check"
  CHECK ("location" <> 'backup' OR "objectKey" ~ '^ws/[^/]+/job/[^/]+/final/[A-Za-z0-9_-]+$');
