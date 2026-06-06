-- ScoringModel: persists ScorerV2 weights and metrics per workspace
CREATE TABLE "ScoringModel" (
  "id"                 TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "weights"            JSONB NOT NULL,
  "performanceMetrics" JSONB NOT NULL,
  "updateCount"        INTEGER NOT NULL DEFAULT 0,
  "lastWeightUpdate"   TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScoringModel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScoringModel_workspaceId_key" ON "ScoringModel"("workspaceId");
ALTER TABLE "ScoringModel" ADD CONSTRAINT "ScoringModel_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ScoringOutcome: individual reply outcomes feeding the feedback loop
CREATE TABLE "ScoringOutcome" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "leadId"           TEXT,
  "prospectId"       TEXT NOT NULL,
  "score"            DOUBLE PRECISION NOT NULL,
  "replied"          BOOLEAN NOT NULL,
  "replyIntent"      TEXT,
  "messageRelevance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "channelUsed"      TEXT NOT NULL DEFAULT 'EMAIL',
  "scoringModelId"   TEXT NOT NULL,
  "recordedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScoringOutcome_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScoringOutcome_workspaceId_idx" ON "ScoringOutcome"("workspaceId");
CREATE INDEX "ScoringOutcome_scoringModelId_idx" ON "ScoringOutcome"("scoringModelId");
CREATE INDEX "ScoringOutcome_leadId_idx" ON "ScoringOutcome"("leadId");
ALTER TABLE "ScoringOutcome" ADD CONSTRAINT "ScoringOutcome_scoringModelId_fkey"
  FOREIGN KEY ("scoringModelId") REFERENCES "ScoringModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
