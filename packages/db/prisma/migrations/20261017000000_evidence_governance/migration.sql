-- C4: evidence governance (retention wait policy, hold ledger flags, deletion requests).
-- Additive only. Rollback: docs/plans/C4_EVIDENCE_GOVERNANCE_ROLLBACK.sql

ALTER TABLE "RetentionPolicy" ADD COLUMN "deletionWaitDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "RetentionPolicy" ADD COLUMN "pendingWaitDays" INTEGER;
ALTER TABLE "RetentionPolicy" ADD COLUMN "pendingWaitRequestedAt" TIMESTAMP(3);
ALTER TABLE "RetentionPolicy" ADD COLUMN "pendingWaitRequestedBy" TEXT;
ALTER TABLE "RetentionPolicy" ADD COLUMN "requireDistinctReviewer" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "LegalHold" ADD COLUMN "ledgeredAt" TIMESTAMP(3);
ALTER TABLE "LegalHold" ADD COLUMN "releaseLedgeredAt" TIMESTAMP(3);

CREATE TABLE "EvidenceDeletionRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "waitDays" INTEGER,
    "notBefore" TIMESTAMP(3),
    "approvalExpiresAt" TIMESTAMP(3),
    "approvalSeal" TEXT,
    "executionStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "activeFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvidenceDeletionRequest_activeFileId_key" ON "EvidenceDeletionRequest"("activeFileId");
CREATE INDEX "EvidenceDeletionRequest_workspaceId_status_idx" ON "EvidenceDeletionRequest"("workspaceId", "status");
CREATE INDEX "EvidenceDeletionRequest_status_notBefore_idx" ON "EvidenceDeletionRequest"("status", "notBefore");

ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_workspaceId_fileId_fkey" FOREIGN KEY ("workspaceId", "fileId") REFERENCES "EvidenceFile"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written guards (Prisma does not model CHECK constraints).
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_wait_days_check"
  CHECK ("deletionWaitDays" BETWEEN 1 AND 365);
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_pending_wait_check"
  CHECK (("pendingWaitDays" IS NULL AND "pendingWaitRequestedAt" IS NULL AND "pendingWaitRequestedBy" IS NULL)
      OR ("pendingWaitDays" BETWEEN 1 AND 365 AND "pendingWaitRequestedAt" IS NOT NULL AND "pendingWaitRequestedBy" IS NOT NULL));

ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_status_check"
  CHECK ("status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTING', 'COMPLETED'));
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_reason_check"
  CHECK (length(btrim("reason")) >= 10);
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_wait_days_check"
  CHECK ("waitDays" IS NULL OR "waitDays" BETWEEN 1 AND 365);
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_attempts_check"
  CHECK ("attempts" >= 0);
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_lastError_check"
  CHECK ("lastError" IS NULL OR length("lastError") <= 64);
-- Once approved, every approval field is present, and the wait really is waitDays long.
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_approved_complete_check"
  CHECK ("status" NOT IN ('APPROVED', 'EXECUTING', 'COMPLETED') OR (
    "reviewedByUserId" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "waitDays" IS NOT NULL
    AND "notBefore" IS NOT NULL AND "approvalExpiresAt" IS NOT NULL AND "approvalSeal" IS NOT NULL
    AND "notBefore" >= "reviewedAt" + make_interval(days => "waitDays")
    AND "approvalExpiresAt" > "notBefore"));
-- Exactly the active states hold the one-active-per-file key, and it is the file's own id.
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_active_key_check"
  CHECK (("status" IN ('REQUESTED', 'APPROVED', 'EXECUTING')) = ("activeFileId" IS NOT NULL)
     AND ("activeFileId" IS NULL OR "activeFileId" = "fileId"));
ALTER TABLE "EvidenceDeletionRequest" ADD CONSTRAINT "EvidenceDeletionRequest_completed_check"
  CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));
