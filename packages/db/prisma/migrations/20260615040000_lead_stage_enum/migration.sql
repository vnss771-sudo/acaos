-- Convert Lead.stage from free-form text to the LeadStage enum, preserving data.
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD');
ALTER TABLE "Lead" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "Lead" ALTER COLUMN "stage" TYPE "LeadStage" USING ("stage"::"LeadStage");
ALTER TABLE "Lead" ALTER COLUMN "stage" SET DEFAULT 'NEW';
