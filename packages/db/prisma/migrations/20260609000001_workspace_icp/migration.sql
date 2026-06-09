-- CreateTable
CREATE TABLE "WorkspaceICP" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minEmployees" INTEGER NOT NULL DEFAULT 1,
    "maxEmployees" INTEGER NOT NULL DEFAULT 999999,
    "targetGeos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mustHaveEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceICP_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceICP_workspaceId_key" ON "WorkspaceICP"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceICP" ADD CONSTRAINT "WorkspaceICP_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
