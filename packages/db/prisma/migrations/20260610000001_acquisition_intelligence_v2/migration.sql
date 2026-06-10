-- Acquisition Intelligence Engine v2
-- Adds: granular signal types, signal ledger fields, expected revenue scoring,
--       message intelligence models, strategy card fields on Recommendation

-- ── 1. Expand SignalType enum ─────────────────────────────────────────────────
ALTER TYPE "SignalType" ADD VALUE 'JOB_POSTING_SPIKE';
ALTER TYPE "SignalType" ADD VALUE 'CONTRACT_AWARDED';
ALTER TYPE "SignalType" ADD VALUE 'TENDER_PUBLISHED';
ALTER TYPE "SignalType" ADD VALUE 'PERMIT_APPROVED';
ALTER TYPE "SignalType" ADD VALUE 'OFFICE_OPENING';
ALTER TYPE "SignalType" ADD VALUE 'PRICING_PAGE_CHANGED';
ALTER TYPE "SignalType" ADD VALUE 'ENTERPRISE_PAGE_LAUNCHED';
ALTER TYPE "SignalType" ADD VALUE 'GOV_GRANT_RECEIVED';
ALTER TYPE "SignalType" ADD VALUE 'PROJECT_START_DETECTED';
ALTER TYPE "SignalType" ADD VALUE 'TECH_STACK_CHANGED';

-- ── 2. MessageEvent enum ──────────────────────────────────────────────────────
CREATE TYPE "MessageEvent" AS ENUM (
  'SENT', 'OPENED', 'CLICKED', 'REPLIED',
  'MEETING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'
);

-- ── 3. Signal ledger enrichment ───────────────────────────────────────────────
ALTER TABLE "Signal"
  ADD COLUMN "rawType"           TEXT,
  ADD COLUMN "normalizedType"    TEXT,
  ADD COLUMN "category"          TEXT,
  ADD COLUMN "confidence"        INTEGER NOT NULL DEFAULT 70,
  ADD COLUMN "buyingImplication" TEXT,
  ADD COLUMN "predictedNeeds"    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "evidenceUrl"       TEXT,
  ADD COLUMN "expiresAt"         TIMESTAMP(3);

CREATE INDEX "Signal_expiresAt_idx" ON "Signal"("expiresAt");

-- ── 4. Prospect — expected revenue scoring fields ─────────────────────────────
ALTER TABLE "Prospect"
  ADD COLUMN "retentionProbability"  DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  ADD COLUMN "expansionProbability"  DOUBLE PRECISION NOT NULL DEFAULT 0.2,
  ADD COLUMN "expectedRevenueScore"  DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX "Prospect_workspaceId_expectedRevenueScore_idx"
  ON "Prospect"("workspaceId", "expectedRevenueScore");

-- ── 5. Recommendation — strategy card extensions ──────────────────────────────
ALTER TABLE "Recommendation"
  ADD COLUMN "predictedNeed"      TEXT,
  ADD COLUMN "meetingProbability" DOUBLE PRECISION,
  ADD COLUMN "expectedRevenue"    DOUBLE PRECISION;

-- ── 6. ScoringModel — channel & timing weight columns ─────────────────────────
ALTER TABLE "ScoringModel"
  ADD COLUMN "channelWeights" JSONB,
  ADD COLUMN "timingWeights"  JSONB;

-- ── 7. MessageExperiment table ────────────────────────────────────────────────
CREATE TABLE "MessageExperiment" (
  "id"                  TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "subject"             TEXT,
  "painAngle"           TEXT,
  "ctaType"             TEXT,
  "industry"            TEXT,
  "channel"             TEXT NOT NULL,
  "messageLength"       INTEGER,
  "personalizationType" TEXT,
  "timing"              TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageExperiment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MessageExperiment"
  ADD CONSTRAINT "MessageExperiment_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "MessageExperiment_workspaceId_idx"         ON "MessageExperiment"("workspaceId");
CREATE INDEX "MessageExperiment_workspaceId_channel_idx" ON "MessageExperiment"("workspaceId", "channel");
CREATE INDEX "MessageExperiment_workspaceId_industry_idx" ON "MessageExperiment"("workspaceId", "industry");

-- ── 8. MessageOutcome table ───────────────────────────────────────────────────
CREATE TABLE "MessageOutcome" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "experimentId" TEXT,
  "prospectId"   TEXT,
  "event"        "MessageEvent" NOT NULL,
  "channel"      TEXT NOT NULL,
  "sentAt"       TIMESTAMP(3),
  "respondedAt"  TIMESTAMP(3),
  "dealValue"    DOUBLE PRECISION,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageOutcome_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MessageOutcome"
  ADD CONSTRAINT "MessageOutcome_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MessageOutcome_experimentId_fkey"
    FOREIGN KEY ("experimentId") REFERENCES "MessageExperiment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MessageOutcome_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MessageOutcome_workspaceId_idx"          ON "MessageOutcome"("workspaceId");
CREATE INDEX "MessageOutcome_experimentId_idx"         ON "MessageOutcome"("experimentId");
CREATE INDEX "MessageOutcome_prospectId_idx"           ON "MessageOutcome"("prospectId");
CREATE INDEX "MessageOutcome_workspaceId_event_idx"    ON "MessageOutcome"("workspaceId", "event");
CREATE INDEX "MessageOutcome_workspaceId_channel_idx"  ON "MessageOutcome"("workspaceId", "channel");
