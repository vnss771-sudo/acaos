-- Engagement observation window on outbound sends. Additive only.
ALTER TABLE "OutreachSent" ADD COLUMN "engagementOutcome" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "observationWindowDays" INTEGER;
ALTER TABLE "OutreachSent" ADD COLUMN "observationDueAt" TIMESTAMP(3);
ALTER TABLE "OutreachSent" ADD COLUMN "observedAt" TIMESTAMP(3);
CREATE INDEX "OutreachSent_status_engagementOutcome_sentAt_idx" ON "OutreachSent"("status", "engagementOutcome", "sentAt");
