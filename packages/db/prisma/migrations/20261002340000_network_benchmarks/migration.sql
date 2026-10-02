-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "networkOptInAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NetworkBenchmark" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "contributors" INTEGER NOT NULL,
    "opportunities" INTEGER NOT NULL,
    "conversations" INTEGER NOT NULL,
    "closed" INTEGER NOT NULL,
    "won" INTEGER NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "conversationRate" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkBenchmark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NetworkBenchmark_eventType_key" ON "NetworkBenchmark"("eventType");

