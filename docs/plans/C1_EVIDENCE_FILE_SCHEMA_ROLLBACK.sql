-- Manual rollback for 20261015000000_evidence_file_metadata (Prisma has no down-migrations).
-- Safe ONLY while the new tables are empty or their contents are disposable: it drops them.
BEGIN;
DROP TRIGGER IF EXISTS "EvidenceDeletionLog_append_only" ON "EvidenceDeletionLog";
DROP FUNCTION IF EXISTS "EvidenceDeletionLog_append_only"();
DROP TABLE IF EXISTS "EvidenceDeletionLog";
DROP TABLE IF EXISTS "LegalHold";
DROP TABLE IF EXISTS "RetentionPolicy";
DROP TABLE IF EXISTS "EvidenceFileCopy";
DROP TABLE IF EXISTS "EvidenceFile";
DROP INDEX IF EXISTS "JobTechnicianEvidence_workspaceId_jobId_id_key";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015000000_evidence_file_metadata';
COMMIT;
