-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "commercialOpportunityId" TEXT;

-- AlterTable
ALTER TABLE "CommercialOpportunity" ADD COLUMN     "recommendation" JSONB,
ADD COLUMN     "recommendationKind" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_commercialOpportunityId_key" ON "Recommendation"("commercialOpportunityId");

-- CreateIndex
CREATE INDEX "CommercialOpportunity_workspaceId_status_recommendationKind_idx" ON "CommercialOpportunity"("workspaceId", "status", "recommendationKind");

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_commercialOpportunityId_fkey" FOREIGN KEY ("commercialOpportunityId") REFERENCES "CommercialOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

