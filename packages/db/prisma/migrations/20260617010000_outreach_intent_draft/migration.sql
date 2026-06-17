-- Stage 3 of the OutreachIntent bridge: hold the evidence-derived draft on the
-- intent. Additive: new nullable columns only.
ALTER TABLE "OutreachIntent" ADD COLUMN "draftSubject" TEXT;
ALTER TABLE "OutreachIntent" ADD COLUMN "draftBody" TEXT;
ALTER TABLE "OutreachIntent" ADD COLUMN "draftFollowup" TEXT;
ALTER TABLE "OutreachIntent" ADD COLUMN "draftGeneratedAt" TIMESTAMP(3);
