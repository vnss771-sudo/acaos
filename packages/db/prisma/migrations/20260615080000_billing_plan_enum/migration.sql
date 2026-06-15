-- Convert Workspace.plan from free-form text to a DB-enforced enum, preserving
-- existing data via an in-place cast. Defensively normalize any value outside the
-- known set to 'free' first so the cast can't fail on legacy/garbage data.

UPDATE "Workspace" SET "plan" = 'free' WHERE "plan" NOT IN ('free', 'starter', 'growth');

CREATE TYPE "BillingPlan" AS ENUM ('free', 'starter', 'growth');
ALTER TABLE "Workspace" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "Workspace" ALTER COLUMN "plan" TYPE "BillingPlan" USING ("plan"::"BillingPlan");
ALTER TABLE "Workspace" ALTER COLUMN "plan" SET DEFAULT 'free';
