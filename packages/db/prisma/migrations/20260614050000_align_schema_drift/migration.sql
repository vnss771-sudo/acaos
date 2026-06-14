-- Align the database with packages/db/prisma/schema.prisma, eliminating two
-- pieces of drift that had accumulated between the schema and the migration
-- history. Both are functionally benign in production (workspace ids are cuids
-- that never update, and Prisma always sends an explicit array value), but the
-- drift caused `prisma migrate dev` to generate surprise migrations and would
-- trip a schema-drift guard in CI. This migration makes the two sides agree.

-- 1. WorkspaceICP.excludedIndustries was created with a DB-level default of
--    `ARRAY[]::TEXT[]` (migration 20260613140000), but the schema declares the
--    column with no @default, matching the sibling String[] columns. Drop the
--    stray default so the DB matches the schema.
ALTER TABLE "WorkspaceICP" ALTER COLUMN "excludedIndustries" DROP DEFAULT;

-- 2. ProcessedEmail.workspaceId's foreign key was created with the implicit
--    `ON UPDATE NO ACTION` (migration 20260614000000), while the schema's
--    relation generates `ON UPDATE CASCADE`. Recreate the constraint so the
--    referential action matches what Prisma expects.
ALTER TABLE "ProcessedEmail" DROP CONSTRAINT "ProcessedEmail_workspaceId_fkey";
ALTER TABLE "ProcessedEmail" ADD CONSTRAINT "ProcessedEmail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
