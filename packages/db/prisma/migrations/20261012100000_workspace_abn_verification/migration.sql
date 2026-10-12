-- ABN Lookup verification of the sender entity (E2). Additive, all nullable.
ALTER TABLE "Workspace"
  ADD COLUMN "senderAbn" TEXT,
  ADD COLUMN "senderAbnStatus" TEXT,
  ADD COLUMN "senderAbnEntityName" TEXT,
  ADD COLUMN "senderAbnVerifiedAt" TIMESTAMP(3);
