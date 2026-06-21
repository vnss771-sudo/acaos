-- Retention-purge support indexes. The retention sweep deletes by a global time
-- predicate (col < cutoff) with no workspace filter, so the existing
-- workspace-/type-first compound indexes can't serve it. Add standalone
-- single-column time indexes on every purged table. Additive only.
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
CREATE INDEX "DiscoveryRun_startedAt_idx" ON "DiscoveryRun"("startedAt");
CREATE INDEX "OutreachSent_sentAt_idx" ON "OutreachSent"("sentAt");
CREATE INDEX "RefreshToken_createdAt_idx" ON "RefreshToken"("createdAt");
CREATE INDEX "ProcessedEmail_processedAt_idx" ON "ProcessedEmail"("processedAt");
CREATE INDEX "EmailVerificationToken_createdAt_idx" ON "EmailVerificationToken"("createdAt");
CREATE INDEX "PasswordResetToken_createdAt_idx" ON "PasswordResetToken"("createdAt");
CREATE INDEX "ProcessedStripeEvent_processedAt_idx" ON "ProcessedStripeEvent"("processedAt");
