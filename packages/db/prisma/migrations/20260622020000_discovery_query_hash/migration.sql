-- Async discovery support: a stable query hash on DiscoveryRun so a repeated
-- discover request collapses onto an already-RUNNING run instead of starting a
-- duplicate provider search. Additive, nullable — legacy rows stay null.

ALTER TABLE "DiscoveryRun" ADD COLUMN "queryHash" TEXT;

CREATE INDEX "DiscoveryRun_workspaceId_queryHash_idx" ON "DiscoveryRun"("workspaceId", "queryHash");
