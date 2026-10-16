# Evidence backup and restore drill (C3)

Status: **procedure only.** Nothing here has been run against real buckets. No provisioning, production credentials, deployment or upload enablement is part of C3. Any FAIL below blocks production enablement.

## How it works

- Finalised evidence (`EvidenceFile.status = AVAILABLE`) is copied by the **worker** to a separate R2 bucket. The backup copy is an `EvidenceFileCopy` row with `location = 'backup'`, tracked independently of the file status: `PENDING → VERIFYING → VERIFIED | FAILED`, with `attempts`, `lastAttemptAt` and a short `lastError` code.
- `VERIFIED` means: the primary was re-read and matched the recorded SHA-256/length, the backup object was written (or an identical one already existed), read back, and matched again, and the file was unchanged when the state flipped. **Nothing may be described as protected until its backup is `VERIFIED`.**
- Durability: the `evidence-sweep` job (every 15 min) queues every AVAILABLE file whose backup is missing, failed or stuck. There is no dependence on an enqueue at finalisation.
- A backup object that already exists with different bytes (`backup_conflict`) is an incident: it is left untouched and reported every sweep.
- Integrity codes (alert immediately): `primary_mismatch`, `backup_conflict`, `readback_mismatch`, `verify_mismatch`, `verify_missing`. Alert also when the oldest unverified file is over 24 h old. Both are logged at `error` by the sweep (`service: evidence-backup`) with counts only, no keys, endpoints or URLs.
- C3 deletes nothing, in either store. Retention and legal holds are unchanged; workspace erasure stays blocked until C4.

## Credentials (least privilege)

| Actor | Primary bucket | Backup bucket |
|---|---|---|
| API | read/write presign only (as C2) | **none** |
| Backup worker | read | write + read (no delete) |
| Restore operator (short-lived, per drill) | write | read |

The application code never calls delete on the backup store. **Correction (2026-10-16): R2's documented API-token levels are Admin Read & Write, Admin Read, Object Read & Write and Object Read; none is "write but not delete", so the provider cannot enforce this for the backup writer.** Scope the writer token to the one bucket (Object Read & Write), use a separate Object Read token for the restore operator, keep the credential off every service that does not need it, and test what the token can do (see `docs/plans/C5E_STAGING_VALIDATION_PROPOSAL.md`). Treat deletion by a compromised writer as a residual risk for the C4b provider-isolation decision. Use separate buckets per environment. Do not paste credentials, keys or presigned URLs into tickets or logs.

## Restore tool

```
npm run evidence:restore -- --workspace <id> --job <id> --file <id>                      # dry-run (default)
npm run evidence:restore -- --workspace <id> --job <id> --file <id> --execute \
    --approved-by <owner user id> --reason "<ticket / short reason>"
```

- Workspace, job and file must all match the database. The file must be `AVAILABLE` with a `VERIFIED` backup.
- A primary that is present and matches the recorded hash is **never overwritten** (`primary_valid`).
- Promotion is a **conditional write** (`If-None-Match: *` when the primary was missing, `If-Match: <ETag inspected>` when it was corrupted), and the file record is re-checked just before it. An object that appears or changes after inspection makes the write fail instead of being overwritten; concurrent restores write the key once. This relies on the storage provider enforcing S3 conditional writes: **verify that on the actual Railway and R2 buckets before trusting it** (step 0 below).
- Executing needs an **owner of that workspace** as approver and a reason; the audit record (`restore_started`) is written before anything changes and the restore is refused if it cannot be written. The bytes are staged under a temporary key, verified, the primary is re-checked, then promoted and verified again; `restore_completed` is audited.
- Legal holds do not block a restore (it only adds data back) and are shown in the report.
- Exit code 2 = refused by a safety check; 1 = unexpected error.

## Drill (disposable staging buckets only)

Prerequisites (owner approvals): a staging Railway bucket and a staging R2 bucket created for this drill, scoped tokens as in the table, `EVIDENCE_UPLOADS_ENABLED` and `EVIDENCE_BACKUP_ENABLED` set on a **staging** worker only.

0. Run the integration suite against the staging buckets (`ACAOS_S3_IT=1`, see `tests-db/evidence-s3-integration.test.ts`); in particular the conditional-write test must PASS. If a provider ignores `If-None-Match`/`If-Match`, restore must not be used without a human checking the primary first.
1. Record commit SHA, environment, bucket aliases, operator, UTC time.
2. Upload a test photo through staging; wait for finalisation. Note file id, workspace id, SHA-256 and length from the database.
3. Wait for the sweep (or queue the file); confirm the backup row is `VERIFIED` and **read-back checksum equals the primary**.
4. In the staging primary bucket only, delete the final object. Record the time (RPO reference).
5. Dry-run the restore: it must report `would_restore`, `primary: missing`, and change nothing.
6. Attempt an execute with a non-owner approver, then with an owner of a different workspace: both must be refused, nothing written, and a `restore_refused` audit event recorded on the file's workspace.
7. Execute with a workspace owner. Confirm `restored`, then compare the restored SHA-256 and length with step 2. Confirm no `/restore/` staging object remains.
8. Re-run the dry-run: it must now report `primary_valid`.
9. Confirm both audit events exist, then corrupt one backup object in staging and confirm the next sweep/verifier reports an integrity incident and the alert fires.
10. Record RPO (data loss window) and RTO (step 4 to step 7 completion).

## Evidence record (fill in per drill)

| Check | Result |
|---|---|
| Commit SHA / environment / bucket aliases / operator / UTC | |
| File and workspace id (redacted), expected SHA-256 and length | |
| Backup read-back checksum equals primary | PASS / FAIL |
| Primary removed only in the disposable staging bucket | PASS / FAIL |
| Dry-run identifies the missing primary and mutates nothing | PASS / FAIL |
| Approved restore recovers the exact SHA-256 and length | PASS / FAIL |
| Non-owner and cross-workspace restore denied and audited | PASS / FAIL |
| Valid primary not overwritten; conditional writes enforced by the provider | PASS / FAIL |
| Corrupted backup detected and alerted | PASS / FAIL |
| RPO / RTO measured, alerts observed | PASS / FAIL |

## Not covered here (open owner decisions)

Railway plan and hard limit; R2 account ownership, credentials and whether bucket locks are available (unverified); an independent PostgreSQL backup (the database is authoritative for hashes, holds and keys, so the object backup alone is not a full recovery); Australian legal review of the 7-year default; controlled erasure of primary and backup copies (C4); Alpine `sharp` smoke test; malware-scanning policy.
