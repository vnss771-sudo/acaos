-- Inbox/Replies (data layer): persist AI-derived reply metadata on each send so
-- the Inbox/Review surfaces can show what came back. Additive nullable columns
-- only. The raw inbound reply body is intentionally NOT stored (privacy /
-- retention) — only these classifier-derived fields.
ALTER TABLE "OutreachSent" ADD COLUMN "replySummary" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "replyKeyQuote" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "replySuggestedAction" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "replyUrgency" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "replyConfidence" INTEGER;
ALTER TABLE "OutreachSent" ADD COLUMN "replyIsAutoReply" BOOLEAN;
