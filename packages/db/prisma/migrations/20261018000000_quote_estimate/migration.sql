-- Quote estimate builder: the advisory cost/margin breakdown a quote's price was
-- built from (packages/backend-core/src/lib/quoteEstimate.ts). Additive and
-- nullable; existing quotes keep NULL (no estimate). No backfill, no constraint
-- on existing rows. Rollback: ALTER TABLE "Quote" DROP COLUMN "estimate";
ALTER TABLE "Quote" ADD COLUMN "estimate" JSONB;
