-- Replace the PARTIAL unique index on Signal(prospectId, fingerprint) with a
-- FULL unique index.
--
-- The schema declares @@unique([prospectId, fingerprint]) and the application
-- upserts signals with `where: { prospectId_fingerprint: { ... } }`, which
-- Prisma compiles to `INSERT ... ON CONFLICT ("prospectId","fingerprint") DO
-- UPDATE`. PostgreSQL cannot use a *partial* index as an ON CONFLICT arbiter
-- unless the statement repeats the index predicate, which Prisma never emits.
-- The original partial index therefore caused every signal upsert to fail at
-- runtime with: "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification".
--
-- A full unique index matches what the Prisma schema/client expect and still
-- allows multiple NULL-fingerprint signals per prospect, because PostgreSQL
-- treats NULLs as distinct in unique indexes (the default NULLS DISTINCT
-- behavior). The index keeps the Prisma-generated name so the client's
-- compound-unique selector resolves to it.

DROP INDEX "Signal_prospectId_fingerprint_key";

CREATE UNIQUE INDEX "Signal_prospectId_fingerprint_key"
  ON "Signal"("prospectId", "fingerprint");
