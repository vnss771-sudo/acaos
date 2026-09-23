-- AlterTable
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN     "domainHealth" JSONB,
ADD COLUMN     "domainHealthCheckedAt" TIMESTAMP(3);
