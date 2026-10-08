-- Cumulative discovery source health counters (UQ-13). Additive, zero defaults:
-- existing rows start with no history rather than a fabricated one.
ALTER TABLE "DiscoverySourceState"
  ADD COLUMN "runCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "successCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "warningCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fetchedTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "matchedTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "createdTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastLatencyMs" INTEGER,
  ADD COLUMN "latencyTotalMs" INTEGER NOT NULL DEFAULT 0;
