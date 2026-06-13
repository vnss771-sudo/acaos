-- CreateTable
CREATE TABLE "WorkspaceEmailConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "smtpUser" TEXT,
    "smtpPass" TEXT,
    "smtpFrom" TEXT,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "imapUser" TEXT,
    "imapPass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceEmailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceEmailConfig_workspaceId_key" ON "WorkspaceEmailConfig"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceEmailConfig" ADD CONSTRAINT "WorkspaceEmailConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
