-- Links a Prospect to the Lead it was converted into (the "Convert to Lead"
-- action — see POST /api/prospects/:id/convert-to-lead). Nullable: most
-- Prospects are never converted. @unique on convertedLeadId keeps the
-- relation strictly 1:1.

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "convertedAt" TIMESTAMP(3),
ADD COLUMN     "convertedLeadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Prospect_convertedLeadId_key" ON "Prospect"("convertedLeadId");

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_convertedLeadId_fkey" FOREIGN KEY ("convertedLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
