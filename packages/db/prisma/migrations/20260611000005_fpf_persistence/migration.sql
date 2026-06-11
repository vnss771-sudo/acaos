-- False Positive Filter decision persistence on Prospect
-- Avoids recomputing classifyProspectSignals() on every API request.
-- Written by score-prospects worker each scoring cycle.

ALTER TABLE "Prospect" ADD COLUMN "fpfDecision" TEXT;
ALTER TABLE "Prospect" ADD COLUMN "fpfReason"   TEXT;
