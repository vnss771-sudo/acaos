-- Pre-send timing fit on sends and learning samples. Additive only.
ALTER TABLE "OutreachSent" ADD COLUMN "timingFitScore" DOUBLE PRECISION;
ALTER TABLE "OutreachSent" ADD COLUMN "timingFitReasons" JSONB;
ALTER TABLE "OutreachSent" ADD COLUMN "timingFitVersion" INTEGER;
ALTER TABLE "ScoringOutcome" ADD COLUMN "timingFit" DOUBLE PRECISION;
