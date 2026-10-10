-- Repeat jobs per site and shift→job attribution (UQ-24).
--
-- A site could hold only one Job, and economics/closeout costed every shift on
-- the site to it. Shifts now carry the Job they are costed to, so a second Job
-- at the same site keeps its own hours and margin.

ALTER TABLE "OpsShiftRecord" ADD COLUMN "jobId" TEXT;

-- Backfill while Job.opsJobSiteId is still unique: each existing shift belongs
-- to the one Job its site had, so the attribution is unambiguous.
UPDATE "OpsShiftRecord" s
SET "jobId" = j."id"
FROM "Job" j
WHERE j."opsJobSiteId" = s."jobSiteId" AND j."workspaceId" = s."workspaceId";

DROP INDEX "Job_opsJobSiteId_key";
CREATE INDEX "Job_workspaceId_opsJobSiteId_idx" ON "Job"("workspaceId", "opsJobSiteId");
CREATE INDEX "OpsShiftRecord_workspaceId_jobId_idx" ON "OpsShiftRecord"("workspaceId", "jobId");

ALTER TABLE "OpsShiftRecord" ADD CONSTRAINT "OpsShiftRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
