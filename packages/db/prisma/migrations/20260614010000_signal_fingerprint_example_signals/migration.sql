-- Add fingerprint field to Signal for deduplication.
-- Prevents repeated enrichment runs from creating duplicate signals for the same event.
-- Fingerprint format: source:type:title-slug:YYYY-MM
-- Nullable — existing signals without fingerprints remain unaffected.

ALTER TABLE "Signal" ADD COLUMN "fingerprint" TEXT;

-- Partial unique index — only enforce uniqueness when fingerprint is set.
-- Two rows with fingerprint=NULL are still allowed (they represent unknown/untracked events).
CREATE UNIQUE INDEX "Signal_prospectId_fingerprint_key"
  ON "Signal"("prospectId", "fingerprint")
  WHERE "fingerprint" IS NOT NULL;
