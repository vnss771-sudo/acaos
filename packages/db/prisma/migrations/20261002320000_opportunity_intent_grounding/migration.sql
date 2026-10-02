-- AlterTable
ALTER TABLE "OutreachIntent" ADD COLUMN     "commercialOpportunityId" TEXT,
ADD COLUMN     "grounding" JSONB;

-- CreateIndex
CREATE INDEX "OutreachIntent_commercialOpportunityId_idx" ON "OutreachIntent"("commercialOpportunityId");

-- AddForeignKey
ALTER TABLE "OutreachIntent" ADD CONSTRAINT "OutreachIntent_commercialOpportunityId_fkey" FOREIGN KEY ("commercialOpportunityId") REFERENCES "CommercialOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

