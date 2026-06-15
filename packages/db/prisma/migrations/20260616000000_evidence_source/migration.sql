-- Provenance/traceability for signals. Additive: new EvidenceSource table plus a
-- nullable Signal.evidenceSourceId FK (existing signals stay unlinked).

CREATE TABLE "EvidenceSource" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "prospectId"  TEXT NOT NULL,
  "provider"    TEXT NOT NULL,
  "sourceType"  TEXT NOT NULL,
  "sourceUrl"   TEXT,
  "observedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"   TIMESTAMP(3),
  "confidence"  DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "rawText"     TEXT,
  "metadata"    JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EvidenceSource_workspaceId_prospectId_idx" ON "EvidenceSource"("workspaceId", "prospectId");
CREATE INDEX "EvidenceSource_provider_observedAt_idx" ON "EvidenceSource"("provider", "observedAt");

ALTER TABLE "EvidenceSource"
  ADD CONSTRAINT "EvidenceSource_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceSource"
  ADD CONSTRAINT "EvidenceSource_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Signal" ADD COLUMN "evidenceSourceId" TEXT;
CREATE INDEX "Signal_evidenceSourceId_idx" ON "Signal"("evidenceSourceId");
ALTER TABLE "Signal"
  ADD CONSTRAINT "Signal_evidenceSourceId_fkey"
  FOREIGN KEY ("evidenceSourceId") REFERENCES "EvidenceSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
