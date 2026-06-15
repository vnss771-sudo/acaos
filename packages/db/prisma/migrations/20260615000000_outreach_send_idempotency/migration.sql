-- Outbox idempotency: at most one OutreachSent per (campaignId, leadId).
-- Postgres treats NULLs as distinct, so rows with a null campaignId or leadId
-- (e.g. non-campaign sends) are unaffected.
CREATE UNIQUE INDEX "OutreachSent_campaignId_leadId_key" ON "OutreachSent"("campaignId", "leadId");
