-- Stage 5 of the OutreachIntent bridge: stamp intelligence provenance onto each
-- send so it's self-auditable. Additive: new nullable columns only.
ALTER TABLE "OutreachSent" ADD COLUMN "outreachIntentId" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "recommendationId" TEXT;
ALTER TABLE "OutreachSent" ADD COLUMN "evidenceSnapshot" JSONB;
CREATE INDEX "OutreachSent_outreachIntentId_idx" ON "OutreachSent"("outreachIntentId");
