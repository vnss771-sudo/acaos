-- CreateEnum
CREATE TYPE "OpsJobStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OpsRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "OpsShiftType" AS ENUM ('REGULAR', 'OVERTIME', 'CALLOUT', 'ON_CALL');

-- CreateEnum
CREATE TYPE "OpsRosterStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "OpsAlertType" AS ENUM ('MISSING_HEAT_CHECK', 'FATIGUE_THRESHOLD', 'MISSING_ALLOWANCE');

-- CreateEnum
CREATE TYPE "OpsAlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "OpsAlertStatus" AS ENUM ('OPEN', 'REVIEWED');

-- CreateTable
CREATE TABLE "OpsCrewMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "crewName" TEXT,
    "baseRate" DOUBLE PRECISION,
    "allowanceProfile" TEXT,
    "licenceNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsCrewMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsJobSite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobCode" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "location" TEXT,
    "supervisor" TEXT,
    "status" "OpsJobStatus" NOT NULL DEFAULT 'ACTIVE',
    "shiftType" TEXT,
    "riskLevel" "OpsRiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "radiusMeters" INTEGER NOT NULL DEFAULT 500,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsJobSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsShiftRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "jobSiteId" TEXT NOT NULL,
    "shiftDate" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "totalHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allowanceTag" TEXT NOT NULL DEFAULT 'NONE',
    "outdoorHighRisk" BOOLEAN NOT NULL DEFAULT false,
    "heatCheckCompleted" BOOLEAN NOT NULL DEFAULT false,
    "fatigueConcern" BOOLEAN NOT NULL DEFAULT false,
    "corRelated" BOOLEAN NOT NULL DEFAULT false,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "clockInLat" DOUBLE PRECISION,
    "clockInLng" DOUBLE PRECISION,
    "clockOutLat" DOUBLE PRECISION,
    "clockOutLng" DOUBLE PRECISION,
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsShiftRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shiftRecordId" TEXT,
    "alertType" "OpsAlertType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "severity" "OpsAlertSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "OpsAlertStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsRosterEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "jobSiteId" TEXT NOT NULL,
    "rosterDate" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "shiftType" "OpsShiftType" NOT NULL DEFAULT 'REGULAR',
    "status" "OpsRosterStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsRosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsCrewMember_workspaceId_isActive_idx" ON "OpsCrewMember"("workspaceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "OpsCrewMember_workspaceId_employeeCode_key" ON "OpsCrewMember"("workspaceId", "employeeCode");

-- CreateIndex
CREATE INDEX "OpsJobSite_workspaceId_status_idx" ON "OpsJobSite"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpsJobSite_workspaceId_jobCode_key" ON "OpsJobSite"("workspaceId", "jobCode");

-- CreateIndex
CREATE INDEX "OpsShiftRecord_workspaceId_shiftDate_idx" ON "OpsShiftRecord"("workspaceId", "shiftDate");

-- CreateIndex
CREATE INDEX "OpsShiftRecord_workspaceId_crewMemberId_endTime_idx" ON "OpsShiftRecord"("workspaceId", "crewMemberId", "endTime");

-- CreateIndex
CREATE INDEX "OpsAlert_workspaceId_status_idx" ON "OpsAlert"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "OpsAlert_workspaceId_severity_idx" ON "OpsAlert"("workspaceId", "severity");

-- CreateIndex
CREATE INDEX "OpsAlert_workspaceId_createdAt_idx" ON "OpsAlert"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsRosterEntry_workspaceId_rosterDate_idx" ON "OpsRosterEntry"("workspaceId", "rosterDate");

-- CreateIndex
CREATE INDEX "OpsRosterEntry_workspaceId_crewMemberId_idx" ON "OpsRosterEntry"("workspaceId", "crewMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "OpsRosterEntry_workspaceId_crewMemberId_rosterDate_startTim_key" ON "OpsRosterEntry"("workspaceId", "crewMemberId", "rosterDate", "startTime");

-- CreateIndex
-- Partial unique index: at most one OPEN (endTime IS NULL) shift per crew member.
-- Prisma's schema DSL has no WHERE-qualified @@unique, so this exists only here —
-- see the comment on OpsShiftRecord.endTime in schema.prisma. This is what makes
-- "no double clock-in" an atomic DB-level guarantee instead of a check-then-create
-- race between the SELECT in clock.ts and the subsequent INSERT.
CREATE UNIQUE INDEX "OpsShiftRecord_open_shift_per_crew_member" ON "OpsShiftRecord"("workspaceId", "crewMemberId") WHERE "endTime" IS NULL;

-- AddForeignKey
ALTER TABLE "OpsCrewMember" ADD CONSTRAINT "OpsCrewMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsJobSite" ADD CONSTRAINT "OpsJobSite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsShiftRecord" ADD CONSTRAINT "OpsShiftRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsShiftRecord" ADD CONSTRAINT "OpsShiftRecord_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "OpsCrewMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsShiftRecord" ADD CONSTRAINT "OpsShiftRecord_jobSiteId_fkey" FOREIGN KEY ("jobSiteId") REFERENCES "OpsJobSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_shiftRecordId_fkey" FOREIGN KEY ("shiftRecordId") REFERENCES "OpsShiftRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsRosterEntry" ADD CONSTRAINT "OpsRosterEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsRosterEntry" ADD CONSTRAINT "OpsRosterEntry_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "OpsCrewMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsRosterEntry" ADD CONSTRAINT "OpsRosterEntry_jobSiteId_fkey" FOREIGN KEY ("jobSiteId") REFERENCES "OpsJobSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
