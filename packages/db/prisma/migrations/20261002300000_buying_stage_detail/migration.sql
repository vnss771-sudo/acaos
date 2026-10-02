-- Buying-stage intelligence: stage confidence, reasons and the stage's move. Additive only.
-- AlterTable
ALTER TABLE "CommercialOpportunity" ADD COLUMN     "buyingStageDetail" JSONB;

