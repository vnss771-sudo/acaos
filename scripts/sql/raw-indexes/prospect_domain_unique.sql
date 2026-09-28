-- From migration 20260622030000_prospect_domain_unique (keep identical).
-- Concurrency-safe guard behind the check-then-create discovery dedup
-- (discoveryImport.ts relies on its P2002).
CREATE UNIQUE INDEX IF NOT EXISTS "Prospect_workspaceId_domainKey_unique"
  ON "Prospect" ("workspaceId", "domainKey")
  WHERE "domainKey" IS NOT NULL;
