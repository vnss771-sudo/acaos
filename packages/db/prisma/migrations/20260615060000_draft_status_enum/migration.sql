-- Convert OutreachDraft.status from free-form text to the DraftStatus enum, preserving data.
CREATE TYPE "DraftStatus" AS ENUM ('DRAFTED', 'APPROVED', 'REJECTED', 'SENT', 'SKIPPED');
ALTER TABLE "OutreachDraft" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OutreachDraft" ALTER COLUMN "status" TYPE "DraftStatus" USING ("status"::"DraftStatus");
ALTER TABLE "OutreachDraft" ALTER COLUMN "status" SET DEFAULT 'DRAFTED';
