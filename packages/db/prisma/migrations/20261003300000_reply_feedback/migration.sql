-- Reply classification feedback stored on the send (lib/classificationAccuracy.ts). Additive only.
ALTER TABLE "OutreachSent" ADD COLUMN "replyFeedback" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "replyIntentCorrected" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "replyFeedbackAt" TIMESTAMP(3);
ALTER TABLE "OutreachSent" ADD COLUMN "replyFeedbackByUserId" TEXT;
CREATE INDEX "OutreachSent_workspaceId_replyFeedbackAt_idx" ON "OutreachSent"("workspaceId", "replyFeedbackAt");
