-- Records why an OutreachIntent exists: RECOMMENDATION (evidence crossed the
-- auto-recommend threshold, or an operator asked for one) or ONBOARDING (prepared
-- so a new workspace can experience the loop on its own data). Additive only.
ALTER TABLE "OutreachIntent" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'RECOMMENDATION';
