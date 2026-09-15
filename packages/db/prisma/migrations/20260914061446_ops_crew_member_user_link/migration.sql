-- Link an OpsCrewMember to the app account they ARE (nullable: many crew
-- members never sign in), so clock in/out can require the caller be that
-- crew member — see apps/api/src/routes/ops/clock.ts.

-- AlterTable
ALTER TABLE "OpsCrewMember" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OpsCrewMember_workspaceId_userId_key" ON "OpsCrewMember"("workspaceId", "userId");

-- AddForeignKey
ALTER TABLE "OpsCrewMember" ADD CONSTRAINT "OpsCrewMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
