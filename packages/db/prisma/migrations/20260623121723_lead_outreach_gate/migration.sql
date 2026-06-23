-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "outreachSkipReason" TEXT,
ADD COLUMN     "outreachSkippedAt" TIMESTAMP(3);
