# Evidence: independent PostgreSQL backup and recovery requirements

Status: **requirements and procedure; not yet provisioned or drilled.** Complements `docs/RECOVERY.md` (general Postgres posture) and `EVIDENCE_RESTORE_DRILL.md` (object restore). Evidence uploads must stay disabled until the items under "Gate" are done and evidenced.

## Why this matters more for evidence than for other data

The object backup (C3) copies **bytes**. Everything that gives those bytes meaning lives only in PostgreSQL: which workspace, job, technician and submission a file belongs to, its SHA-256 and size, which key it lives under, retention deadlines, legal holds, the deletion log and the audit trail. Object keys are random and carry no inventory. Losing the database while keeping the buckets leaves unlabelled files that cannot be attributed, verified, restored or lawfully deleted. The manifest (`storeEvidenceManifest`) is a supporting inventory only, it is not a substitute: it omits keys, actors, holds history and audit.

So the database needs its own backup that does **not** share a failure domain with the primary database host, and the recovery procedure has to deal with the database and the object stores being restored to *different points in time*.

## Requirements (the Gate)

1. **Managed backups on the database provider**, with the retention and PITR window in `docs/RECOVERY.md`. Railway's managed Postgres backup features and limits must be confirmed from the dashboard for the actual plan (not assumed): record the plan, the snapshot schedule, whether point-in-time recovery exists, retention, and who can restore. **Unverified at the time of writing.**
2. **An independent logical backup**: a scheduled `pg_dump` (custom format) to a bucket and credentials that belong to neither the primary evidence store nor the evidence backup store, encrypted at rest, retained at least as long as the evidence retention policy requires the *metadata* to be provable (the default evidence retention is 7 years, pending legal review). The dump job's credential can write but not delete or overwrite. The restore operator's credential is separate and short-lived.
3. **RPO/RTO stated and measured** for the pair (database + objects), not each alone. Suggested starting point: database RPO ≤ 5 min (PITR) or ≤ 24 h from the independent dump; objects RPO = time to `VERIFIED` backup (alert at 24 h, see the drill runbook); RTO ≤ 4 h for evidence access. Owners to confirm.
4. **A tested restore** of a dump into a throwaway database, followed by the reconciliation below, with timings recorded, at least quarterly and before first enablement.
5. **Monitoring**: backup job success/age alert; dump size sanity check; alert if the newest dump is older than 26 h.
6. **Access control**: backup credentials not present on the API service; restore credentials issued per drill; database dump files treated as containing personal data (technician identities, customer/site references) under the same retention and erasure rules (see "Erasure" below).

## Recovery scenarios and procedure

Always begin with: **stop evidence writes** (`EVIDENCE_UPLOADS_ENABLED=false` and `EVIDENCE_BACKUP_ENABLED=false` on api and worker, scale the worker down) so nothing new races the restore.

### A. Database lost or rolled back; buckets intact (the common case)

1. Restore PostgreSQL (PITR if available, else latest dump) to a new instance. Point `DATABASE_URL`/`DIRECT_URL` at it; run `prisma migrate deploy`.
2. The restored database is *older* than the objects. Run the reconciliation queries below. Expect three kinds of difference:
   - **Objects with no row** (uploads/finalisations after the restore point). These are unattributed. Do **not** delete them. List them, hold them in place, and attribute them from the audit trail or the technician's re-submission if the business requires; otherwise decide deletion under the controlled-erasure process (C4), never ad hoc.
   - **Rows with no object** (should not happen when the objects are intact): restore the primary from the backup bucket with `npm run evidence:restore`.
   - **Rows whose recorded SHA-256 differs from the object**: treat as an integrity incident; the backup copy is the tiebreaker.
3. Re-enable backups first (`EVIDENCE_BACKUP_ENABLED=true`), let the sweep reach zero unverified files, then re-enable uploads.

### B. Objects lost; database intact

Use `EVIDENCE_RESTORE_DRILL.md` per file. For bulk loss, script `restoreEvidenceFile` over the `manifest`/database list, in dry-run first. Owner approval is still required per workspace.

### C. Both lost or a ransomware-style event

Restore the database from the independent dump, then the objects from the backup bucket as in A/B. Evidence whose backup copy was never `VERIFIED` is unrecoverable by design: that is why nothing may be called protected before then.

### D. Restored database resurrects data that was lawfully deleted

The deletion log is itself in PostgreSQL, so an older restore can bring back rows (and the right to believe objects exist) for files that were deleted after the restore point. Before re-enabling anything, replay deletions from the independent record kept per C4 (each controlled deletion must also be appended to a write-once location outside this database). **This is a prerequisite for enabling any deletion in C4.**

## Reconciliation queries (read-only)

Run against the restored database; compare with a bucket listing (`rclone lsf --files-only -R <remote>:<bucket>/ws/`) for the same keys.

```sql
-- Files the database says exist, with the key the primary should hold
SELECT f."workspaceId", f."jobId", f."id" AS "fileId", c."objectKey", f."sha256", f."sizeBytes"
FROM "EvidenceFile" f
JOIN "EvidenceFileCopy" c ON c."fileId" = f."id" AND c."location" = 'primary' AND c."status" = 'VERIFIED'
WHERE f."status" = 'AVAILABLE';

-- AVAILABLE files that are NOT yet protected (no verified backup)
SELECT f."id", f."workspaceId", f."finalizedAt"
FROM "EvidenceFile" f
WHERE f."status" = 'AVAILABLE'
  AND NOT EXISTS (SELECT 1 FROM "EvidenceFileCopy" b WHERE b."fileId" = f."id" AND b."location" = 'backup' AND b."status" = 'VERIFIED');

-- Backup bookkeeping needing attention
SELECT "lastError", count(*) FROM "EvidenceFileCopy" WHERE "location" = 'backup' AND "status" <> 'VERIFIED' GROUP BY 1;

-- Active legal holds (must be re-checked after any restore)
SELECT "workspaceId", "scope", "jobId", "placedAt" FROM "LegalHold" WHERE "releasedAt" IS NULL;
```

Set difference between the first query's `objectKey` column and the bucket listing gives "rows with no object" and "objects with no row".

## Erasure and retention interactions

- Workspace erasure remains blocked while any `EvidenceFile` row (including tombstones) or legal hold exists. Dumps taken before an erasure still contain that data: the dump retention schedule must be no longer than the longest period for which erased data may lawfully persist in backups, and the policy must say so. Legal review required.
- A dump is not a deletion mechanism. Do not restore a dump over a live database to "undo" a deletion without the replay step in D.

## Evidence record (fill in per drill)

| Check | Result |
|---|---|
| Provider plan, snapshot schedule, PITR yes/no, retention (from the dashboard) | |
| Independent dump job: last success time, size, destination alias | |
| Dump restored into a throwaway database; `migrate deploy` clean | PASS / FAIL |
| Reconciliation: counts of rows without objects / objects without rows | |
| Database + object RPO and RTO measured | |
| Dump credential cannot delete/overwrite (tested) | PASS / FAIL |
| Alert for stale dump observed | PASS / FAIL |

Any FAIL blocks production enablement of uploads.
