-- Cadence: multi-step outreach sequence templates
CREATE TABLE "Cadence" (
  "id"          TEXT    NOT NULL,
  "workspaceId" TEXT    NOT NULL,
  "name"        TEXT    NOT NULL,
  "steps"       JSONB   NOT NULL DEFAULT '[]',
  "isDefault"   BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Cadence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Cadence_workspaceId_idx" ON "Cadence"("workspaceId");

ALTER TABLE "Cadence"
  ADD CONSTRAINT "Cadence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CadenceEnrollment: per-prospect cadence tracking
CREATE TABLE "CadenceEnrollment" (
  "id"           TEXT    NOT NULL,
  "workspaceId"  TEXT    NOT NULL,
  "prospectId"   TEXT    NOT NULL,
  "cadenceId"    TEXT    NOT NULL,
  "currentStep"  INTEGER NOT NULL DEFAULT 0,
  "status"       TEXT    NOT NULL DEFAULT 'ACTIVE',
  "enrolledAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextActionAt" TIMESTAMP(3),
  "completedAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CadenceEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CadenceEnrollment_prospectId_cadenceId_key"
  ON "CadenceEnrollment"("prospectId", "cadenceId");

CREATE INDEX "CadenceEnrollment_workspaceId_idx"
  ON "CadenceEnrollment"("workspaceId");

CREATE INDEX "CadenceEnrollment_status_nextActionAt_idx"
  ON "CadenceEnrollment"("status", "nextActionAt");

ALTER TABLE "CadenceEnrollment"
  ADD CONSTRAINT "CadenceEnrollment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CadenceEnrollment"
  ADD CONSTRAINT "CadenceEnrollment_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CadenceEnrollment"
  ADD CONSTRAINT "CadenceEnrollment_cadenceId_fkey"
  FOREIGN KEY ("cadenceId") REFERENCES "Cadence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
