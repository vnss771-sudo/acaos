-- CreateTable: OpportunityBrief — signal→problem→owner→offer intelligence dossier
CREATE TABLE "OpportunityBrief" (
    "id"                   TEXT NOT NULL,
    "workspaceId"          TEXT NOT NULL,
    "prospectId"           TEXT NOT NULL,
    "buyingWindowStrength" TEXT NOT NULL,
    "whyNow"               TEXT[],
    "likelyProblem"        TEXT NOT NULL,
    "problemOwnerRole"     TEXT NOT NULL,
    "offerAngle"           TEXT NOT NULL,
    "outreachApproach"     TEXT NOT NULL,
    "confidenceScore"      INTEGER NOT NULL,
    "evidenceItems"        JSONB NOT NULL DEFAULT '[]',
    "scoreBenchmark"       JSONB NOT NULL DEFAULT '{}',
    "rejectionReasons"     TEXT[],
    "generatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpportunityBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityBrief_prospectId_key" ON "OpportunityBrief"("prospectId");
CREATE INDEX "OpportunityBrief_workspaceId_idx" ON "OpportunityBrief"("workspaceId");
CREATE INDEX "OpportunityBrief_workspaceId_generatedAt_idx" ON "OpportunityBrief"("workspaceId", "generatedAt");

-- AddForeignKey
ALTER TABLE "OpportunityBrief" ADD CONSTRAINT "OpportunityBrief_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpportunityBrief" ADD CONSTRAINT "OpportunityBrief_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
