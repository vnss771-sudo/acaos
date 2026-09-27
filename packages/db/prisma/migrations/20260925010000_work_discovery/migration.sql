-- Work discovery ("Find work"): discovery profile, per-source sweep state, and
-- project-centric opportunities. Additive only.
-- CreateTable
CREATE TABLE "DiscoveryProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trades" TEXT[],
    "keywords" TEXT[],
    "baseLat" DOUBLE PRECISION,
    "baseLng" DOUBLE PRECISION,
    "radiusKm" INTEGER NOT NULL DEFAULT 50,
    "regions" TEXT[],
    "minValue" INTEGER,
    "sources" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoverySourceState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cursor" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastWarning" TEXT,
    "lastFetched" INTEGER NOT NULL DEFAULT 0,
    "lastMatched" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoverySourceState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "address" TEXT,
    "locality" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "distanceKm" DOUBLE PRECISION,
    "valueAmount" DOUBLE PRECISION,
    "currency" TEXT,
    "publishedAt" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "counterpartyName" TEXT,
    "counterpartyAbn" TEXT,
    "counterpartyEmail" TEXT,
    "counterpartyPhone" TEXT,
    "buyerName" TEXT,
    "score" INTEGER NOT NULL,
    "matchedTrades" TEXT[],
    "reasons" JSONB NOT NULL,
    "recommendedAction" TEXT,
    "rawData" JSONB,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedByUserId" TEXT,
    "opsJobSiteId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryProfile_workspaceId_key" ON "DiscoveryProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoverySourceState_workspaceId_source_key" ON "DiscoverySourceState"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_status_score_idx" ON "Opportunity"("workspaceId", "status", "score");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_firstSeenAt_idx" ON "Opportunity"("workspaceId", "firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_workspaceId_source_externalId_key" ON "Opportunity"("workspaceId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "DiscoveryProfile" ADD CONSTRAINT "DiscoveryProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySourceState" ADD CONSTRAINT "DiscoverySourceState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_opsJobSiteId_fkey" FOREIGN KEY ("opsJobSiteId") REFERENCES "OpsJobSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

