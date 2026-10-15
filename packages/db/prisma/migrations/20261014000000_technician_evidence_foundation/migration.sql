CREATE UNIQUE INDEX "Job_workspaceId_id_key" ON "Job"("workspaceId", "id");
CREATE UNIQUE INDEX "OpsCrewMember_workspaceId_id_key" ON "OpsCrewMember"("workspaceId", "id");

CREATE TABLE "JobTechnicianAssignment" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "jobId" TEXT NOT NULL,
  "crewMemberId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobTechnicianAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobTechnicianAssignment_workspaceId_jobId_crewMemberId_key"
  ON "JobTechnicianAssignment"("workspaceId", "jobId", "crewMemberId");
CREATE INDEX "JobTechnicianAssignment_workspaceId_crewMemberId_idx"
  ON "JobTechnicianAssignment"("workspaceId", "crewMemberId");
ALTER TABLE "JobTechnicianAssignment" ADD CONSTRAINT "JobTechnicianAssignment_workspaceId_jobId_fkey"
  FOREIGN KEY ("workspaceId", "jobId") REFERENCES "Job"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobTechnicianAssignment" ADD CONSTRAINT "JobTechnicianAssignment_workspaceId_crewMemberId_fkey"
  FOREIGN KEY ("workspaceId", "crewMemberId") REFERENCES "OpsCrewMember"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobTechnicianEvidence" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "jobId" TEXT NOT NULL,
  "crewMemberId" TEXT NOT NULL, "submissionId" TEXT NOT NULL, "kind" TEXT NOT NULL, "content" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobTechnicianEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobTechnicianEvidence_workspaceId_jobId_createdAt_idx"
  ON "JobTechnicianEvidence"("workspaceId", "jobId", "createdAt");
ALTER TABLE "JobTechnicianEvidence" ADD CONSTRAINT "JobTechnicianEvidence_workspaceId_jobId_fkey"
  FOREIGN KEY ("workspaceId", "jobId") REFERENCES "Job"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Evidence author is a real crew member; do not orphan evidence on crew deletion.
ALTER TABLE "JobTechnicianEvidence" ADD CONSTRAINT "JobTechnicianEvidence_workspaceId_crewMemberId_fkey"
  FOREIGN KEY ("workspaceId", "crewMemberId") REFERENCES "OpsCrewMember"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobTechnicianAssignment" ADD CONSTRAINT "JobTechnicianAssignment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobTechnicianEvidence" ADD CONSTRAINT "JobTechnicianEvidence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "JobTechnicianEvidence_workspaceId_crewMemberId_submissionId_key" ON "JobTechnicianEvidence"("workspaceId", "crewMemberId", "submissionId");
