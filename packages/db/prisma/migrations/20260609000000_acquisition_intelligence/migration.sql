-- Enums
CREATE TYPE "SignalType" AS ENUM ('HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE', 'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE');
CREATE TYPE "BuyingStage" AS ENUM ('RESEARCHING', 'EVALUATING', 'COMPARING', 'PURCHASING', 'INACTIVE');
CREATE TYPE "OutcomeStage" AS ENUM ('DISCOVERED', 'VIEWED', 'CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST');

-- Prospect table
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "employeeCount" INTEGER,
    "estimatedRevenue" DOUBLE PRECISION,
    "location" TEXT,
    "description" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "contactTitle" TEXT,
    "linkedinUrl" TEXT,
    "opportunityScore" INTEGER NOT NULL DEFAULT 0,
    "intentScore" INTEGER NOT NULL DEFAULT 0,
    "fitScore" INTEGER NOT NULL DEFAULT 0,
    "timingScore" INTEGER NOT NULL DEFAULT 0,
    "confidenceScore" INTEGER NOT NULL DEFAULT 0,
    "buyingStage" "BuyingStage" NOT NULL DEFAULT 'RESEARCHING',
    "outcomeStage" "OutcomeStage" NOT NULL DEFAULT 'DISCOVERED',
    "expectedDealValue" DOUBLE PRECISION,
    "winProbability" DOUBLE PRECISION,
    "lastSignalAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "aiSummary" TEXT,
    "sourceTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- Signal table
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "strength" INTEGER NOT NULL,
    "sourceReliability" INTEGER NOT NULL DEFAULT 70,
    "industryRelevance" INTEGER NOT NULL DEFAULT 50,
    "title" TEXT,
    "description" TEXT,
    "sourceUrl" TEXT,
    "source" TEXT,
    "rawData" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- Recommendation table
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "bestContact" TEXT,
    "bestTiming" TEXT,
    "bestChannel" TEXT,
    "messageAngle" TEXT,
    "reasoning" TEXT,
    "actionText" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'MEDIUM',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "expiresAt" TIMESTAMP(3),
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- ProspectOutcome table
CREATE TABLE "ProspectOutcome" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "stage" "OutcomeStage" NOT NULL,
    "notes" TEXT,
    "dealValue" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProspectOutcome_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProspectOutcome" ADD CONSTRAINT "ProspectOutcome_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProspectOutcome" ADD CONSTRAINT "ProspectOutcome_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Prospect_workspaceId_idx" ON "Prospect"("workspaceId");
CREATE INDEX "Prospect_workspaceId_opportunityScore_idx" ON "Prospect"("workspaceId", "opportunityScore");
CREATE INDEX "Prospect_workspaceId_buyingStage_idx" ON "Prospect"("workspaceId", "buyingStage");
CREATE INDEX "Prospect_workspaceId_outcomeStage_idx" ON "Prospect"("workspaceId", "outcomeStage");
CREATE INDEX "Signal_workspaceId_idx" ON "Signal"("workspaceId");
CREATE INDEX "Signal_prospectId_idx" ON "Signal"("prospectId");
CREATE INDEX "Signal_type_idx" ON "Signal"("type");
CREATE INDEX "Signal_detectedAt_idx" ON "Signal"("detectedAt");
CREATE INDEX "Recommendation_workspaceId_idx" ON "Recommendation"("workspaceId");
CREATE INDEX "Recommendation_prospectId_idx" ON "Recommendation"("prospectId");
CREATE INDEX "ProspectOutcome_workspaceId_idx" ON "ProspectOutcome"("workspaceId");
CREATE INDEX "ProspectOutcome_prospectId_idx" ON "ProspectOutcome"("prospectId");
