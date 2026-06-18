-- Scope discovered prospects to a Mission so the mission control plane can own
-- its prospects and carry the link through to recommendations/intents.
-- Additive + nullable: existing prospects stay mission-less.

ALTER TABLE "Prospect" ADD COLUMN "missionId" TEXT;

CREATE INDEX "Prospect_missionId_idx" ON "Prospect"("missionId");

ALTER TABLE "Prospect"
  ADD CONSTRAINT "Prospect_missionId_fkey"
  FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index the mission action-queue lookup on OutreachIntent.
CREATE INDEX "OutreachIntent_missionId_idx" ON "OutreachIntent"("missionId");
