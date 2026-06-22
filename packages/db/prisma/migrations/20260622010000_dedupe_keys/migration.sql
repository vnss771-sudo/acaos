-- Normalized dedupe keys for Prospect and Lead. Additive, all nullable: existing
-- rows stay null and are backfilled lazily as they're touched (or by a one-off
-- backfill). New imports/discovery populate them at write time. The keys collapse
-- case/whitespace/punctuation/www./plus-address variants so the same real-world
-- entity isn't imported twice.

ALTER TABLE "Prospect" ADD COLUMN "companyNameKey" TEXT;
ALTER TABLE "Prospect" ADD COLUMN "emailKey" TEXT;

CREATE INDEX "Prospect_workspaceId_companyNameKey_idx" ON "Prospect"("workspaceId", "companyNameKey");
CREATE INDEX "Prospect_workspaceId_emailKey_idx" ON "Prospect"("workspaceId", "emailKey");

ALTER TABLE "Lead" ADD COLUMN "emailKey" TEXT;

CREATE INDEX "Lead_workspaceId_emailKey_idx" ON "Lead"("workspaceId", "emailKey");
