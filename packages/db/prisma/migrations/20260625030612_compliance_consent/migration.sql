-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "lawfulBasis" TEXT,
ADD COLUMN     "liaAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "subprocessorsAckAt" TIMESTAMP(3),
ADD COLUMN     "subprocessorsAckVersion" TEXT,
ADD COLUMN     "targetsCanada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_workspaceId_emailKey_idx" ON "ConsentRecord"("workspaceId", "emailKey");

-- CreateIndex
CREATE INDEX "ConsentRecord_workspaceId_recordedAt_idx" ON "ConsentRecord"("workspaceId", "recordedAt");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
