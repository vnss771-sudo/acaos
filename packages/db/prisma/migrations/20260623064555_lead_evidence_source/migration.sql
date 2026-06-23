-- CreateTable
CREATE TABLE "LeadEvidenceSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL DEFAULT 'inferred',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "signal" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'llm-research',
    "sourceType" TEXT NOT NULL DEFAULT 'inference',
    "sourceUrl" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvidenceSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadEvidenceSource_workspaceId_leadId_idx" ON "LeadEvidenceSource"("workspaceId", "leadId");

-- CreateIndex
CREATE INDEX "LeadEvidenceSource_leadId_idx" ON "LeadEvidenceSource"("leadId");

-- AddForeignKey
ALTER TABLE "LeadEvidenceSource" ADD CONSTRAINT "LeadEvidenceSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvidenceSource" ADD CONSTRAINT "LeadEvidenceSource_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
