-- Signal intelligence (publishedAt), explicit Offer model, and CommercialOpportunity.
-- Additive only: one nullable column and two new tables.
-- AlterTable
ALTER TABLE "Signal" ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "missionId" TEXT,
    "name" TEXT NOT NULL,
    "problemSolved" TEXT,
    "targetCustomer" TEXT,
    "targetBuyerTitles" TEXT[],
    "triggeringEvents" TEXT[],
    "qualifyingKeywords" TEXT[],
    "disqualifyingKeywords" TEXT[],
    "geographies" TEXT[],
    "minOpportunityValueCents" INTEGER,
    "dealValueMinCents" INTEGER,
    "dealValueMaxCents" INTEGER,
    "urgencyIndicators" TEXT[],
    "proofPoints" TEXT[],
    "recommendedActions" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialOpportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "offerId" TEXT,
    "missionId" TEXT,
    "offerKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventTitle" TEXT NOT NULL,
    "whyNow" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "evidenceConfidence" INTEGER NOT NULL,
    "independentSources" INTEGER NOT NULL,
    "trustworthySignals" INTEGER NOT NULL,
    "offerFit" INTEGER NOT NULL,
    "intentScore" INTEGER NOT NULL,
    "timingScore" INTEGER NOT NULL,
    "contactability" INTEGER NOT NULL,
    "estimatedValueMinCents" INTEGER,
    "estimatedValueMaxCents" INTEGER,
    "probability" DOUBLE PRECISION NOT NULL,
    "urgency" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "buyingStage" TEXT NOT NULL,
    "recommendedBuyer" TEXT,
    "recommendedAction" TEXT NOT NULL,
    "actionLabel" TEXT NOT NULL,
    "actionReason" TEXT NOT NULL,
    "blockers" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "velocity" JSONB NOT NULL,
    "intelligenceGate" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedByUserId" TEXT,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAssessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Offer_workspaceId_active_idx" ON "Offer"("workspaceId", "active");

-- CreateIndex
CREATE INDEX "Offer_missionId_idx" ON "Offer"("missionId");

-- CreateIndex
CREATE INDEX "CommercialOpportunity_workspaceId_status_priority_idx" ON "CommercialOpportunity"("workspaceId", "status", "priority");

-- CreateIndex
CREATE INDEX "CommercialOpportunity_prospectId_idx" ON "CommercialOpportunity"("prospectId");

-- CreateIndex
CREATE INDEX "CommercialOpportunity_offerId_idx" ON "CommercialOpportunity"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOpportunity_workspaceId_prospectId_offerKey_key" ON "CommercialOpportunity"("workspaceId", "prospectId", "offerKey");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOpportunity" ADD CONSTRAINT "CommercialOpportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOpportunity" ADD CONSTRAINT "CommercialOpportunity_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOpportunity" ADD CONSTRAINT "CommercialOpportunity_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

