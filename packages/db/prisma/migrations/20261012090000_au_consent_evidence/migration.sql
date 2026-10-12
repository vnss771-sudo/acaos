-- Spam Act 2003 (Cth) consent evidence (D2). Additive and nullable/defaulted:
-- no existing row or send path changes behaviour. Rollback = drop the columns.
ALTER TABLE "Workspace" ADD COLUMN "targetsAustralia" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ConsentRecord"
  ADD COLUMN "evidenceUrl" TEXT,
  ADD COLUMN "evidenceAt" TIMESTAMP(3),
  ADD COLUMN "evidenceExcerpt" TEXT,
  ADD COLUMN "evidenceHash" TEXT,
  ADD COLUMN "addressType" TEXT,
  ADD COLUMN "optOutStatementAbsent" BOOLEAN,
  ADD COLUMN "roleRelevant" BOOLEAN;
