-- Concurrency-safe prospect dedup: a partial unique index on (workspaceId,
-- domainKey). This is the belt-and-suspenders guarantee behind the check-then-
-- create dedup in discovery/import — under concurrent runs two creates can both
-- pass the check, and only this constraint stops the duplicate row.
--
-- domainKey predates this migration and is already populated, so existing rows
-- may contain duplicates that would make a naive CREATE UNIQUE INDEX fail on
-- deploy. We resolve that NON-DESTRUCTIVELY: within each (workspaceId, domainKey)
-- group keep the oldest row's key and NULL the key on the rest. No rows are
-- deleted — the older duplicates keep all their data (including the raw `domain`
-- column); they're just excluded from the partial index. Future discovery
-- dedupes against the surviving (oldest) keyed row, so this can't re-duplicate.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "workspaceId", "domainKey"
      ORDER BY "createdAt" ASC, id ASC
    ) AS rn
  FROM "Prospect"
  WHERE "domainKey" IS NOT NULL
)
UPDATE "Prospect" p
SET "domainKey" = NULL
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX "Prospect_workspaceId_domainKey_unique"
ON "Prospect" ("workspaceId", "domainKey")
WHERE "domainKey" IS NOT NULL;
