-- Rollback for 20261016000000_evidence_backup_state. Only safe while no 'backup'
-- copy rows exist (delete them first); then also remove the migration row from
-- _prisma_migrations. Nothing here touches stored objects.
ALTER TABLE "EvidenceFileCopy" DROP CONSTRAINT "EvidenceFileCopy_backup_key_check";
ALTER TABLE "EvidenceFileCopy" DROP CONSTRAINT "EvidenceFileCopy_lastError_check";
ALTER TABLE "EvidenceFileCopy" DROP CONSTRAINT "EvidenceFileCopy_attempts_check";
ALTER TABLE "EvidenceFileCopy" DROP CONSTRAINT "EvidenceFileCopy_status_check";
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_status_check"
  CHECK ("status" IN ('PENDING', 'VERIFIED', 'FAILED', 'DELETED'));
ALTER TABLE "EvidenceFileCopy" DROP COLUMN "lastError";
ALTER TABLE "EvidenceFileCopy" DROP COLUMN "lastAttemptAt";
ALTER TABLE "EvidenceFileCopy" DROP COLUMN "attempts";
