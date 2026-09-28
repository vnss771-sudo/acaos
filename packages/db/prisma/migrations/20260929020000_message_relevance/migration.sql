-- Pre-send message relevance on outbound sends. Additive only.
ALTER TABLE "OutreachSent" ADD COLUMN "messageRelevanceScore" DOUBLE PRECISION;
ALTER TABLE "OutreachSent" ADD COLUMN "messageRelevanceReasons" JSONB;
ALTER TABLE "OutreachSent" ADD COLUMN "messageRelevanceVersion" INTEGER;
