-- UsageRecord: monthly AI call counter per workspace for plan enforcement
CREATE TABLE "UsageRecord" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "action"      TEXT NOT NULL,
  "month"       TEXT NOT NULL,
  "count"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UsageRecord_workspaceId_month_action_key" ON "UsageRecord"("workspaceId", "month", "action");
CREATE INDEX "UsageRecord_workspaceId_idx" ON "UsageRecord"("workspaceId");
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ProcessedEmail: tracks IMAP UIDs already ingested so mailbox sync is idempotent
CREATE TABLE "ProcessedEmail" (
  "id"          TEXT NOT NULL,
  "uid"         INTEGER NOT NULL,
  "messageId"   TEXT,
  "fromAddress" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedEmail_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcessedEmail_uid_key" ON "ProcessedEmail"("uid");
CREATE UNIQUE INDEX "ProcessedEmail_messageId_key" ON "ProcessedEmail"("messageId");
