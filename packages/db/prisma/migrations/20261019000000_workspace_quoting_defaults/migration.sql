-- Workspace quoting defaults (lib/quoteEstimate.ts ESTIMATE_PCT_LIMITS): optional
-- on-cost %, overhead % and target gross margin % copied into a new estimate when
-- the builder opens. Additive and nullable: every existing workspace starts with
-- NULL (no default), so the builder behaves exactly as before. No backfill.
-- Saved quote estimates (Quote.estimate) are not touched and never reference these.
ALTER TABLE "Workspace" ADD COLUMN "defaultOnCostPct" DOUBLE PRECISION;
ALTER TABLE "Workspace" ADD COLUMN "defaultOverheadPct" DOUBLE PRECISION;
ALTER TABLE "Workspace" ADD COLUMN "defaultTargetMarginPct" DOUBLE PRECISION;

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_defaultOnCostPct_range"
  CHECK ("defaultOnCostPct" IS NULL OR ("defaultOnCostPct" >= 0 AND "defaultOnCostPct" <= 200));
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_defaultOverheadPct_range"
  CHECK ("defaultOverheadPct" IS NULL OR ("defaultOverheadPct" >= 0 AND "defaultOverheadPct" <= 200));
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_defaultTargetMarginPct_range"
  CHECK ("defaultTargetMarginPct" IS NULL OR ("defaultTargetMarginPct" >= 0 AND "defaultTargetMarginPct" <= 95));

-- Rollback (loses only the defaults; quotes and saved estimates are unaffected):
--   ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_defaultOnCostPct_range",
--     DROP CONSTRAINT "Workspace_defaultOverheadPct_range", DROP CONSTRAINT "Workspace_defaultTargetMarginPct_range",
--     DROP COLUMN "defaultOnCostPct", DROP COLUMN "defaultOverheadPct", DROP COLUMN "defaultTargetMarginPct";
