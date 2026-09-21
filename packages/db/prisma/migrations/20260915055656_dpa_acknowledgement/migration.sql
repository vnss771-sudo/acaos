-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "dpaAckVersion" TEXT,
ADD COLUMN     "dpaAcknowledgedAt" TIMESTAMP(3);
