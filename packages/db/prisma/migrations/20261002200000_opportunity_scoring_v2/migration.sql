-- Opportunity Scoring 2.0: competition, value score, expected value and the full scorecard.
-- Additive only: four nullable columns and one index.
-- AlterTable
ALTER TABLE "CommercialOpportunity" ADD COLUMN     "competition" INTEGER,
ADD COLUMN     "expectedValueCents" INTEGER,
ADD COLUMN     "scorecard" JSONB,
ADD COLUMN     "valueScore" INTEGER;

-- CreateIndex
CREATE INDEX "CommercialOpportunity_workspaceId_status_expectedValueCents_idx" ON "CommercialOpportunity"("workspaceId", "status", "expectedValueCents");

