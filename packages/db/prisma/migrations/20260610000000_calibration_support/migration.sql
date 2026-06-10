-- Add notes field to Prospect
ALTER TABLE "Prospect" ADD COLUMN "notes" TEXT;

-- Add signalWeights field to ScoringModel
ALTER TABLE "ScoringModel" ADD COLUMN "signalWeights" JSONB;

-- Create WorkspaceICP table
CREATE TABLE "WorkspaceICP" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetIndustries" TEXT[] NOT NULL DEFAULT '{}',
    "minEmployees" INTEGER,
    "maxEmployees" INTEGER,
    "targetGeos" TEXT[] NOT NULL DEFAULT '{}',
    "mustHaveEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceICP_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkspaceICP" ADD CONSTRAINT "WorkspaceICP_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WorkspaceICP_workspaceId_key" ON "WorkspaceICP"("workspaceId");
