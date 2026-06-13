-- Add onboardingCompleted to Workspace
ALTER TABLE "Workspace" ADD COLUMN "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false;

-- Add unsubscribeToken to OutreachSent
ALTER TABLE "OutreachSent" ADD COLUMN "unsubscribeToken" TEXT;
CREATE UNIQUE INDEX "OutreachSent_unsubscribeToken_key" ON "OutreachSent"("unsubscribeToken");

-- Add isExample to Prospect
ALTER TABLE "Prospect" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;

-- Extend WorkspaceICP with onboarding / compliance fields
ALTER TABLE "WorkspaceICP" ADD COLUMN "businessType" TEXT;
ALTER TABLE "WorkspaceICP" ADD COLUMN "outreachTone" TEXT;
ALTER TABLE "WorkspaceICP" ADD COLUMN "approvalMode" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WorkspaceICP" ADD COLUMN "dailySendLimit" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "WorkspaceICP" ADD COLUMN "excludedIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "WorkspaceICP" ADD COLUMN "playbook" TEXT;

-- CreateTable Suppression
CREATE TABLE "Suppression" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "reason"      TEXT NOT NULL DEFAULT 'UNSUBSCRIBED',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Suppression_workspaceId_email_key" ON "Suppression"("workspaceId", "email");
CREATE INDEX "Suppression_workspaceId_idx" ON "Suppression"("workspaceId");

ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
