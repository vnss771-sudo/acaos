-- Phase 15A: commercial capture (Quote, Job). Additive only. See docs/ACQUISITION_OS_DELIVERY.md.

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "commercialOpportunityId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "estimatedHours" DOUBLE PRECISION,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "opsJobSiteId" TEXT NOT NULL,
    "quoteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invoicedRevenueCents" INTEGER,
    "otherCostCents" INTEGER,
    "closeout" JSONB,
    "closeoutVersion" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_workspaceId_status_idx" ON "Quote"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Quote_opportunityId_idx" ON "Quote"("opportunityId");

-- CreateIndex
CREATE INDEX "Quote_commercialOpportunityId_idx" ON "Quote"("commercialOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_opsJobSiteId_key" ON "Job"("opsJobSiteId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_quoteId_key" ON "Job"("quoteId");

-- CreateIndex
CREATE INDEX "Job_workspaceId_status_idx" ON "Job"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_commercialOpportunityId_fkey" FOREIGN KEY ("commercialOpportunityId") REFERENCES "CommercialOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_opsJobSiteId_fkey" FOREIGN KEY ("opsJobSiteId") REFERENCES "OpsJobSite"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written below: constraints Prisma's schema DSL can't express.

-- A quote prices exactly one opportunity of one type. "<= 1" rather than "= 1"
-- because both FKs are ON DELETE SET NULL: a quote outlives a deleted
-- opportunity as economic history. The API requires exactly one on create.
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_one_opportunity_check"
  CHECK (num_nonnulls("opportunityId", "commercialOpportunityId") <= 1);

-- Money is never negative; hours are never negative.
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_amount_nonneg_check" CHECK ("amountCents" >= 0);
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_hours_nonneg_check" CHECK ("estimatedHours" IS NULL OR "estimatedHours" >= 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_money_nonneg_check"
  CHECK (("invoicedRevenueCents" IS NULL OR "invoicedRevenueCents" >= 0) AND ("otherCostCents" IS NULL OR "otherCostCents" >= 0));

-- At most one ACCEPTED quote per opportunity, enforced where it can be atomic.
CREATE UNIQUE INDEX "Quote_one_accepted_per_opportunity" ON "Quote"("opportunityId")
  WHERE "status" = 'ACCEPTED' AND "opportunityId" IS NOT NULL;
CREATE UNIQUE INDEX "Quote_one_accepted_per_commercial_opportunity" ON "Quote"("commercialOpportunityId")
  WHERE "status" = 'ACCEPTED' AND "commercialOpportunityId" IS NOT NULL;

-- Backfill: every job site already created from a WON Work-discovery opportunity
-- gets its Job row (no quote: those predate quotes). Idempotent.
INSERT INTO "Job" ("id", "workspaceId", "opsJobSiteId", "status", "startedAt", "createdAt", "updatedAt")
SELECT 'bf' || md5(o."opsJobSiteId"), o."workspaceId", o."opsJobSiteId", 'ACTIVE', s."createdAt", now(), now()
FROM "Opportunity" o
JOIN "OpsJobSite" s ON s."id" = o."opsJobSiteId"
WHERE o."opsJobSiteId" IS NOT NULL
ON CONFLICT ("opsJobSiteId") DO NOTHING;
