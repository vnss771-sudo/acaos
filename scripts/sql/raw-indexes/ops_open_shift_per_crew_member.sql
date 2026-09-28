-- From migration 20260912215055_ops_module_foundation (keep identical).
-- At most one open shift per crew member (routes/ops/clock.ts relies on it).
CREATE UNIQUE INDEX IF NOT EXISTS "OpsShiftRecord_open_shift_per_crew_member"
  ON "OpsShiftRecord" ("workspaceId", "crewMemberId")
  WHERE "endTime" IS NULL;
