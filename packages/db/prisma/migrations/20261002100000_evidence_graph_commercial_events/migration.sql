-- Evidence graph: CommercialEvent (per prospect, per event kind) and EvidenceLink
-- (signal -> event, with its claim); opportunities link to their event.
-- Additive only: three nullable columns and two new tables.
-- AlterTable
ALTER TABLE "CommercialOpportunity" ADD COLUMN     "commercialEventId" TEXT,
ADD COLUMN     "eventFamily" TEXT,
ADD COLUMN     "implication" TEXT;

-- CreateTable
CREATE TABLE "CommercialEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "implication" TEXT NOT NULL,
    "whyNow" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "independentSources" INTEGER NOT NULL,
    "trustworthySignals" INTEGER NOT NULL,
    "corroborated" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAssessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "commercialEventId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "quality" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "trustworthy" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommercialEvent_workspaceId_status_idx" ON "CommercialEvent"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "CommercialEvent_prospectId_idx" ON "CommercialEvent"("prospectId");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialEvent_workspaceId_prospectId_kind_key" ON "CommercialEvent"("workspaceId", "prospectId", "kind");

-- CreateIndex
CREATE INDEX "EvidenceLink_workspaceId_idx" ON "EvidenceLink"("workspaceId");

-- CreateIndex
CREATE INDEX "EvidenceLink_signalId_idx" ON "EvidenceLink"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceLink_commercialEventId_signalId_key" ON "EvidenceLink"("commercialEventId", "signalId");

-- CreateIndex
CREATE INDEX "CommercialOpportunity_commercialEventId_idx" ON "CommercialOpportunity"("commercialEventId");

-- AddForeignKey
ALTER TABLE "CommercialOpportunity" ADD CONSTRAINT "CommercialOpportunity_commercialEventId_fkey" FOREIGN KEY ("commercialEventId") REFERENCES "CommercialEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialEvent" ADD CONSTRAINT "CommercialEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialEvent" ADD CONSTRAINT "CommercialEvent_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_commercialEventId_fkey" FOREIGN KEY ("commercialEventId") REFERENCES "CommercialEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

