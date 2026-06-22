-- Phase 1 send-safety + AI observability. Additive only:
--   * AiPromptVersion: which prompt/model/version produced an AI draft (traceability)
--   * WorkspaceDraftPolicy: per-workspace deterministic content rules
--   * OutreachDraft: nullable promptVersionId FK + policyViolations JSON
--   * DraftStatus: new POLICY_REVIEW value for drafts flagged by the policy checker
-- Existing rows stay valid: new columns are nullable, the enum value is additive,
-- and no data is rewritten.

-- New DraftStatus value. Postgres requires ADD VALUE outside a transaction block,
-- but Prisma runs each migration file in its own transaction; ADD VALUE ... is
-- safe here because no statement in this file reads the new value at write time.
ALTER TYPE "DraftStatus" ADD VALUE IF NOT EXISTS 'POLICY_REVIEW';

-- AI prompt version snapshots — one row per (workspace, type, version).
CREATE TABLE "AiPromptVersion" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "promptHash"  TEXT NOT NULL,
  "model"       TEXT NOT NULL,
  "maxTokens"   INTEGER,
  "temperature" DOUBLE PRECISION,
  "metadata"    JSONB,
  "isActive"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiPromptVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiPromptVersion_workspaceId_type_version_key" ON "AiPromptVersion"("workspaceId", "type", "version");
CREATE INDEX "AiPromptVersion_workspaceId_type_isActive_idx" ON "AiPromptVersion"("workspaceId", "type", "isActive");
CREATE INDEX "AiPromptVersion_promptHash_idx" ON "AiPromptVersion"("promptHash");

ALTER TABLE "AiPromptVersion"
  ADD CONSTRAINT "AiPromptVersion_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-workspace draft content policy (one row per workspace).
CREATE TABLE "WorkspaceDraftPolicy" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "minSubjectLength" INTEGER NOT NULL DEFAULT 5,
  "maxSubjectLength" INTEGER NOT NULL DEFAULT 80,
  "minBodyLength"    INTEGER NOT NULL DEFAULT 30,
  "maxBodyLength"    INTEGER NOT NULL DEFAULT 3000,
  "forbiddenPhrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "requireTemplate"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceDraftPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceDraftPolicy_workspaceId_key" ON "WorkspaceDraftPolicy"("workspaceId");
CREATE INDEX "WorkspaceDraftPolicy_workspaceId_idx" ON "WorkspaceDraftPolicy"("workspaceId");

ALTER TABLE "WorkspaceDraftPolicy"
  ADD CONSTRAINT "WorkspaceDraftPolicy_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- OutreachDraft provenance + policy result. Both nullable so existing drafts
-- (generated before this feature) remain valid and unlinked.
ALTER TABLE "OutreachDraft" ADD COLUMN "promptVersionId" TEXT;
ALTER TABLE "OutreachDraft" ADD COLUMN "policyViolations" JSONB;

CREATE INDEX "OutreachDraft_promptVersionId_idx" ON "OutreachDraft"("promptVersionId");

ALTER TABLE "OutreachDraft"
  ADD CONSTRAINT "OutreachDraft_promptVersionId_fkey"
  FOREIGN KEY ("promptVersionId") REFERENCES "AiPromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
