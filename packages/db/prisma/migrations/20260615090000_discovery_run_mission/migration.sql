-- Scope discovery runs to a Mission so the mission control plane can show its own
-- discovery activity. Additive + nullable: existing runs stay mission-less.

ALTER TABLE "DiscoveryRun" ADD COLUMN "missionId" TEXT;

CREATE INDEX "DiscoveryRun_missionId_idx" ON "DiscoveryRun"("missionId");

ALTER TABLE "DiscoveryRun"
  ADD CONSTRAINT "DiscoveryRun_missionId_fkey"
  FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
