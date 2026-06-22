# Runbook: Failed database migration

**Severity:** SEV1 if the app can't start or schema is inconsistent; SEV2 if
caught pre-cutover.

ACAOS uses Prisma Migrate. Deploys apply migrations with
`prisma migrate deploy` (non-interactive, applies pending migrations only — see
`docs/MIGRATIONS.md`). When behind PgBouncer, migrations must run over the direct
connection (`DIRECT_URL`), not the pooler. The discipline is
**expand-and-contract**: additive/backward-compatible changes ship first
(expand) so old and new app code both work against the new schema, then a later
release removes the old columns/tables (contract) once nothing reads them. This
is what makes a migration safe to run alongside a rolling deploy and safe to roll
back.

## Symptoms
- Deploy fails at the migrate step; `prisma migrate deploy` errors
  (`P3009` "migrate found failed migrations", a SQL error, or a lock timeout).
- App pods crash-looping on boot, or Prisma `P3009`/drift errors at runtime.
- A migration partially applied (some statements ran before failure).

## Impact
- Depends on stage. A failed **expand** usually leaves the old schema intact and
  the old app code still working (no user impact yet). A failed **contract** or a
  destructive step mid-deploy can break the running app if columns it reads were
  dropped.

## Immediate mitigation
1. **Halt the rollout.** Don't let more pods cycle onto a half-migrated schema.
2. Determine state: `npx prisma migrate status` (against `DIRECT_URL`) shows
   which migrations applied and which failed.
3. If the previous app release is compatible with the **current** DB state
   (the point of expand-and-contract), roll the **app** back to the last good
   release immediately to restore service while you fix the migration.
4. Do NOT run `prisma migrate reset` against production — it drops data.

## Diagnosis steps
- Read the exact failing SQL and error. Common causes: a lock/timeout on a large
  table (long-held `ACCESS EXCLUSIVE`), a not-null/unique constraint added before
  data was backfilled, or running through PgBouncer instead of `DIRECT_URL`.
- Check `_prisma_migrations` for the row marked failed (`rolled_back_at` /
  `applied_steps_count`).
- Confirm whether the migration is idempotent / which statements already
  committed (Prisma runs a migration's statements without an outer transaction
  for some DDL).

## Rollback / resolution steps
1. **Resolve the failed-migration marker** so future deploys aren't blocked:
   - If the migration did NOT effectively apply:
     `npx prisma migrate resolve --rolled-back <migration_name>` (then fix and
     re-deploy a corrected migration).
   - If it DID fully apply despite the error report:
     `npx prisma migrate resolve --applied <migration_name>`.
   (Run these against `DIRECT_URL`.)
2. For a partially-applied destructive migration, write a **corrective forward
   migration** (Prisma has no down-migrations) rather than hand-editing the DB —
   keep history and DB in sync.
3. Re-run `prisma migrate deploy`; confirm `migrate status` is clean and pods
   boot healthy (`/api/ready` 200).
4. Restore the intended app release once the schema is consistent.

## Customer communication
- If service was degraded: "We had a brief deployment issue and rolled back; the
  service is restored." Most expand-stage failures are invisible to customers.

## Prevention follow-up
- Always **expand-and-contract**; never drop/rename in the same release that
  ships the code change. Backfill before adding constraints.
- Run migrations over `DIRECT_URL`; test on a prod-like dataset; review for table
  locks on large tables.
- Gate deploys on a successful `migrate deploy` + `migrate status` check (CI/CD).
</content>
