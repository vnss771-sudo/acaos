-- CreateTable: claim-first outbox for human-written Inbox replies
-- (POST /api/inbox/reply/:replyId/send). Additive only.
CREATE TABLE "InboxReplySend" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "outreachSentId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actorUserId" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "messageId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "InboxReplySend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxReplySend_workspaceId_idempotencyKey_key" ON "InboxReplySend"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "InboxReplySend_outreachSentId_createdAt_idx" ON "InboxReplySend"("outreachSentId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxReplySend_outreachSentId_status_idx" ON "InboxReplySend"("outreachSentId", "status");

-- AddForeignKey
ALTER TABLE "InboxReplySend" ADD CONSTRAINT "InboxReplySend_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxReplySend" ADD CONSTRAINT "InboxReplySend_outreachSentId_fkey" FOREIGN KEY ("outreachSentId") REFERENCES "OutreachSent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
