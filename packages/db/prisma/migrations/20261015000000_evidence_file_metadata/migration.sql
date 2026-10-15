-- CreateTable
CREATE TABLE "EvidenceFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "evidenceId" TEXT,
    "crewMemberId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PHOTO',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contentType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "capturedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3),
    "retentionNote" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceFileCopy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceFileCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 2555,
    "startRule" TEXT NOT NULL DEFAULT 'LATER_OF_UPLOAD_AND_CLOSEOUT',
    "autoDeletionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalHold" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "jobId" TEXT,
    "reason" TEXT NOT NULL,
    "placedByUserId" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedByUserId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "LegalHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceDeletionLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "jobId" TEXT,
    "event" TEXT NOT NULL,
    "actorUserId" TEXT,
    "sha256" TEXT,
    "sizeBytes" INTEGER,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceDeletionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceFile_workspaceId_jobId_createdAt_idx" ON "EvidenceFile"("workspaceId", "jobId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceFile_workspaceId_status_idx" ON "EvidenceFile"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "EvidenceFile_workspaceId_retainUntil_idx" ON "EvidenceFile"("workspaceId", "retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceFile_workspaceId_crewMemberId_submissionId_key" ON "EvidenceFile"("workspaceId", "crewMemberId", "submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceFile_workspaceId_id_key" ON "EvidenceFile"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "EvidenceFileCopy_workspaceId_status_idx" ON "EvidenceFileCopy"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceFileCopy_fileId_location_key" ON "EvidenceFileCopy"("fileId", "location");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceFileCopy_location_objectKey_key" ON "EvidenceFileCopy"("location", "objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionPolicy_workspaceId_key" ON "RetentionPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "LegalHold_workspaceId_releasedAt_idx" ON "LegalHold"("workspaceId", "releasedAt");

-- CreateIndex
CREATE INDEX "LegalHold_workspaceId_jobId_idx" ON "LegalHold"("workspaceId", "jobId");

-- CreateIndex
CREATE INDEX "EvidenceDeletionLog_workspaceId_createdAt_idx" ON "EvidenceDeletionLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceDeletionLog_fileId_idx" ON "EvidenceDeletionLog"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "JobTechnicianEvidence_workspaceId_jobId_id_key" ON "JobTechnicianEvidence"("workspaceId", "jobId", "id");

-- AddForeignKey
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_workspaceId_jobId_fkey" FOREIGN KEY ("workspaceId", "jobId") REFERENCES "Job"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_workspaceId_crewMemberId_fkey" FOREIGN KEY ("workspaceId", "crewMemberId") REFERENCES "OpsCrewMember"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_workspaceId_jobId_evidenceId_fkey" FOREIGN KEY ("workspaceId", "jobId", "evidenceId") REFERENCES "JobTechnicianEvidence"("workspaceId", "jobId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_workspaceId_fileId_fkey" FOREIGN KEY ("workspaceId", "fileId") REFERENCES "EvidenceFile"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_workspaceId_jobId_fkey" FOREIGN KEY ("workspaceId", "jobId") REFERENCES "Job"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written guards (Prisma does not model CHECK constraints or triggers).
-- Statuses are TEXT + CHECK rather than Postgres enums so the allowed set can be
-- changed with an ordinary migration (enum values cannot be removed).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_kind_check"
  CHECK ("kind" IN ('PHOTO'));
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_status_check"
  CHECK ("status" IN ('PENDING', 'AVAILABLE', 'REJECTED', 'DELETING', 'DELETED'));
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_size_check"
  CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0);
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_dimensions_check"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_sha256_check"
  CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_content_type_check"
  CHECK ("contentType" IS NULL OR "contentType" ~ '^[a-z]+/[a-z0-9.+-]+$');
-- A file offered as AVAILABLE must be fully described and finalized.
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_available_complete_check"
  CHECK ("status" <> 'AVAILABLE' OR (
    "contentType" IS NOT NULL AND "sizeBytes" IS NOT NULL AND "sha256" IS NOT NULL AND "finalizedAt" IS NOT NULL));
-- deletedAt is set exactly when the row is the DELETED tombstone.
ALTER TABLE "EvidenceFile" ADD CONSTRAINT "EvidenceFile_deleted_at_check"
  CHECK (("status" = 'DELETED') = ("deletedAt" IS NOT NULL));

ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_location_check"
  CHECK ("location" ~ '^[a-z][a-z0-9_-]{0,31}$');
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_status_check"
  CHECK ("status" IN ('PENDING', 'VERIFIED', 'FAILED', 'DELETED'));
-- Database-level isolation guard: a copy can only live under its own workspace's prefix.
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_key_workspace_prefix_check"
  CHECK (starts_with("objectKey", 'ws/' || "workspaceId" || '/'));
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_size_check"
  CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0);
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_sha256_check"
  CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_verified_complete_check"
  CHECK ("status" <> 'VERIFIED' OR (
    "verifiedAt" IS NOT NULL AND "sha256" IS NOT NULL AND "sizeBytes" IS NOT NULL));
ALTER TABLE "EvidenceFileCopy" ADD CONSTRAINT "EvidenceFileCopy_deleted_at_check"
  CHECK (("status" = 'DELETED') = ("deletedAt" IS NOT NULL));

ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_days_check"
  CHECK ("retentionDays" BETWEEN 1 AND 36500);
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_start_rule_check"
  CHECK ("startRule" IN ('UPLOAD', 'JOB_CLOSEOUT', 'LATER_OF_UPLOAD_AND_CLOSEOUT'));

ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_scope_check"
  CHECK ("scope" IN ('WORKSPACE', 'JOB'));
-- A workspace-wide hold names no job; a job hold must name one.
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_scope_job_check"
  CHECK (("scope" = 'WORKSPACE' AND "jobId" IS NULL) OR ("scope" = 'JOB' AND "jobId" IS NOT NULL));
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_reason_check"
  CHECK (length(btrim("reason")) > 0);
-- Released fields travel together, and a hold cannot be released before it was placed.
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_release_pair_check"
  CHECK (("releasedAt" IS NULL) = ("releasedByUserId" IS NULL));
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_release_order_check"
  CHECK ("releasedAt" IS NULL OR "releasedAt" >= "placedAt");

ALTER TABLE "EvidenceDeletionLog" ADD CONSTRAINT "EvidenceDeletionLog_event_check"
  CHECK (length(btrim("event")) > 0);

-- Append-only: the deletion audit trail cannot be edited or removed in place.
-- (TRUNCATE is not blocked, so test databases can still be reset.)
CREATE FUNCTION "EvidenceDeletionLog_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EvidenceDeletionLog is append-only (% not permitted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "EvidenceDeletionLog_append_only"
  BEFORE UPDATE OR DELETE ON "EvidenceDeletionLog"
  FOR EACH ROW EXECUTE FUNCTION "EvidenceDeletionLog_append_only"();
