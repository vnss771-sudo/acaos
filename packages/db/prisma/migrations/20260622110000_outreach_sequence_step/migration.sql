-- Support multi-step sequences in the outbox: a lead can receive more than one
-- send per campaign (step 1 = initial, >= 2 = follow-ups), while each (campaign,
-- lead, step) stays at-most-once. Expand-and-contract and non-destructive:
-- existing rows are all step 1, so swapping the unique can't collide.

ALTER TABLE "OutreachSent" ADD COLUMN "sequenceStep" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "OutreachSent_campaignId_leadId_key";
CREATE UNIQUE INDEX "OutreachSent_campaignId_leadId_sequenceStep_key"
  ON "OutreachSent"("campaignId", "leadId", "sequenceStep");
