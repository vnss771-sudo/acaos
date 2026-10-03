-- Deterministic reply risk escalation (lib/riskEscalation.ts). Additive only.
ALTER TABLE "OutreachSent" ADD COLUMN "replyRiskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];
