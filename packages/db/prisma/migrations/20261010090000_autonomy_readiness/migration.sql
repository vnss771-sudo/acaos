-- Autonomous-outreach readiness gate (UQ-40): an explicit, versioned workspace
-- opt-in. Every existing workspace starts opted out.
ALTER TABLE "Workspace"
  ADD COLUMN "autonomyOptInAt" TIMESTAMP(3),
  ADD COLUMN "autonomyConsentVersion" TEXT;
