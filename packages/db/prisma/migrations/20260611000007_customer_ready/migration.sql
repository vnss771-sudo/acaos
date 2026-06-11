-- ProspectPageSession
CREATE TABLE "ProspectPageSession" (
    "id"          TEXT NOT NULL,
    "token"       TEXT NOT NULL,
    "chatHistory" JSONB NOT NULL DEFAULT '[]',
    "dealStage"   TEXT NOT NULL DEFAULT 'EXPLORE',
    "viewCount"   INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProspectPageSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProspectPageSession_token_key" ON "ProspectPageSession"("token");

-- EmailSuppression
CREATE TABLE "EmailSuppression" (
    "id"           TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "reason"       TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailSuppression_workspaceId_email_key" ON "EmailSuppression"("workspaceId", "email");
CREATE INDEX "EmailSuppression_workspaceId_idx" ON "EmailSuppression"("workspaceId");
CREATE INDEX "EmailSuppression_workspaceId_email_idx" ON "EmailSuppression"("workspaceId", "email");
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DailyBrief
CREATE TABLE "DailyBrief" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date"        TEXT NOT NULL,
    "hotCount"    INTEGER NOT NULL DEFAULT 0,
    "warmCount"   INTEGER NOT NULL DEFAULT 0,
    "topOpps"     JSONB NOT NULL,
    "sentAt"      TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyBrief_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyBrief_workspaceId_date_key" ON "DailyBrief"("workspaceId", "date");
CREATE INDEX "DailyBrief_workspaceId_idx" ON "DailyBrief"("workspaceId");
ALTER TABLE "DailyBrief" ADD CONSTRAINT "DailyBrief_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cadence.requiresReview
ALTER TABLE "Cadence" ADD COLUMN "requiresReview" BOOLEAN NOT NULL DEFAULT true;

-- WorkspaceProduct.sendLimitPerDay
ALTER TABLE "WorkspaceProduct" ADD COLUMN "sendLimitPerDay" INTEGER NOT NULL DEFAULT 50;
