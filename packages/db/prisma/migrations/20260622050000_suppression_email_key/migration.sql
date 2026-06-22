-- Normalized suppression matching. Adds Suppression.emailKey (trim+lowercase) and
-- swaps the per-workspace uniqueness from `email` to `emailKey`, so case/whitespace
-- variants of the same address can't create duplicate rows or slip a suppressed
-- recipient through. Deploy-safe and effectively non-destructive: `email` was
-- already stored lowercased, so emailKey == email for existing rows and the dedup
-- step is a defensive no-op (a duplicate suppression is redundant — the recipient
-- stays suppressed via the surviving row).

ALTER TABLE "Suppression" ADD COLUMN "emailKey" TEXT;

UPDATE "Suppression" SET "emailKey" = lower(btrim("email"));

-- Defensive dedup: keep the oldest row per (workspaceId, emailKey).
DELETE FROM "Suppression" s
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "workspaceId", lower(btrim("email"))
    ORDER BY "createdAt" ASC, id ASC
  ) AS rn
  FROM "Suppression"
) d
WHERE s.id = d.id AND d.rn > 1;

ALTER TABLE "Suppression" ALTER COLUMN "emailKey" SET NOT NULL;

-- Swap uniqueness from email to emailKey.
DROP INDEX "Suppression_workspaceId_email_key";
CREATE UNIQUE INDEX "Suppression_workspaceId_emailKey_key" ON "Suppression"("workspaceId", "emailKey");
CREATE INDEX "Suppression_workspaceId_createdAt_idx" ON "Suppression"("workspaceId", "createdAt");
