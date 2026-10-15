# Evidence deletion, legal holds and ledger: operator runbook (C4)

Status: **procedure only; nothing is provisioned or enabled.** Read `docs/plans/C4_EVIDENCE_GOVERNANCE.md` first. Any FAIL in the drill blocks enabling destructive operations.

## Services and credentials

| Service | Flags / secrets it may hold | Must NOT hold |
|---|---|---|
| API | `EVIDENCE_DESTRUCTIVE_ENABLED`, `EVIDENCE_DELETION_SEAL_KEY` (seals approvals); `EVIDENCE_LEDGER_*` (append/read); upload settings | any `EVIDENCE_DELETE_*`, backup credentials |
| Upload/backup worker | `EVIDENCE_S3_*`, `EVIDENCE_BACKUP_*` | any `EVIDENCE_DELETE_*` (the service then disables itself) |
| **Deletion runner** (separate service/job) | `EVIDENCE_DESTRUCTIVE_ENABLED`, `EVIDENCE_DELETION_SEAL_KEY`, `EVIDENCE_LEDGER_*`, `EVIDENCE_DELETE_PRIMARY_*`, `EVIDENCE_DELETE_BACKUP_*`, endpoints/buckets (`EVIDENCE_S3_ENDPOINT/BUCKET`, `EVIDENCE_BACKUP_ENDPOINT/BUCKET`), `DATABASE_URL` | the normal upload/backup write tokens |

The delete tokens, the ledger token and the two normal tokens must all be different tokens (the configuration refuses otherwise). Never paste credentials, keys or the seal key into tickets or logs. The MAC key (`EVIDENCE_LEDGER_MAC_KEY`) and seal key (`EVIDENCE_DELETION_SEAL_KEY`) are separate secrets, each at least 32 characters; rotating either invalidates what it signed, so plan rotations around an empty queue and a recorded ledger state.

## One-time setup (owner-approved, staging first)

1. Create a **separate ledger bucket** on Cloudflare R2 (own token; never the evidence or backup buckets). Add a **bucket lock rule** on prefix `v1/` with **indefinite** retention (`wrangler r2 bucket lock add <bucket> --name ledger --prefix v1/ --retention-indefinite`). Record who can remove lock rules (account administrators): that is your residual trust.
2. Create the ledger API token with object read/write for that bucket only.
3. Run `npm run evidence:deletion -- probe-ledger` with the ledger variables. **Required result: `level: "enforced"`** (create-only, overwrite denied, delete denied). `create_only` or `none` means the lock is not effective for this token or conditional writes are not honoured: do not proceed. Record the output in the evidence record below.
4. Create the delete-capable tokens (primary bucket, backup bucket) and put them only in the runner's environment.

## Day to day

- **Place / release a hold:** owners call `POST /api/ops/evidence-governance/holds` (scope `WORKSPACE` or `JOB`, reason of at least 10 characters) and `POST …/holds/:id/release`. Holds work even when destructive operations are disabled.
- **Policy:** `GET/PUT …/policy`. Retention can be lengthened, not shortened. Shortening the wait before deletion is requested with `PUT` and confirmed 24 h later with `POST …/policy/confirm-wait` (or cancelled).
- **Delete a file:** an owner `POST …/deletion-requests` (the file must be AVAILABLE, out of retention, and not under a hold), an owner reviews with `POST …/deletion-requests/:id/approve` (this seals the approval and starts the wait; default 7 days), then the runner executes it after the wait. Owners can `reject` before review or `cancel` before execution. An approval not executed within 30 days after the wait ends is cancelled.
- **Run the runner:** `npm run evidence:deletion -- run` on a schedule (for example hourly). Each cycle: ledger trust gate → sync holds to the ledger → reconcile the database against the ledger → execute due approved requests. Exit code 2 means it refused to run (flag off, invalid config, ledger not enforced or unreachable).
- **Check the ledger:** `npm run evidence:deletion -- verify-ledger --workspace <id>`.

## Monitoring (log lines at `error` level; wire to your alerting)

- `evidence deletion: N request(s) are stuck mid-deletion` — a request is EXECUTING with a `lastError`; inspect it (`GET …/deletion-requests?workspaceId=…&status=EXECUTING`), fix the cause, re-run. Common codes: `ledger_unavailable`, `primary_delete_failed`, `backup_delete_failed`, `*_still_present`, `legal_hold`, `seal_invalid`.
- `deletion request … has an invalid approval seal; refusing` — someone changed an approval outside the API, or the seal key changed. Investigate before anything else.
- Reconciliation `conflicts` (a started deletion that a hold now covers) and `invalidLedgerEntries` (forged or damaged ledger entries) in the cycle output.

## Partial failures

A request left EXECUTING with the file DELETING is the visible, recoverable state: the ledger shows `started`, one of the two copies may already be gone, and nothing is marked DELETED. Fix the cause and run the runner again. If a hold was placed mid-way, the primary may already be gone but the backup remains: restore the primary from the backup (`EVIDENCE_RESTORE_DRILL.md`) if the hold requires the evidence to stay accessible; the deletion resumes only after the hold is released.

## After restoring PostgreSQL from an older backup

Do not re-enable uploads or deletion first. Run `npm run evidence:deletion -- reconcile` (it needs the same gate and credentials as `run`). It re-applies ledger-recorded deletions, removes any stale objects, recreates lost holds and ends holds the ledger shows released, and reports conflicts and unrecoverable holds (for example a hold on a job that no longer exists in the restored database) for a human. Then follow `EVIDENCE_POSTGRES_RECOVERY.md`. A hold placed after the backup *and not yet in the ledger* is lost: the runner syncs holds every cycle, so keep the cycle frequent.

## Workspace erasure

Allowed only when every file is DELETED and confirmed in the ledger, there are no active holds or open requests, and every hold change is in the ledger. The erasure writes `WORKSPACE_ERASED` to the ledger first. If it answers 409 the message lists the blockers (`evidence_not_deleted`, `open_deletion_requests`, `active_legal_hold`, `holds_not_ledgered`, `ledger_unavailable`, `ledger_unconfirmed`, `deletion_disabled`). There is no way to skip them. Legal sign-off for erasure that conflicts with retention is a separate, undecided process.

## Staging drill (real, disposable buckets; owner-approved)

Run the integration suite with the staging settings (`ACAOS_S3_IT=1`, plus the ledger and `ACAOS_IT_DELETE_*` variables; see `tests-db/evidence-s3-integration.test.ts`) and then:

| Check | Result |
|---|---|
| Commit SHA, environment, bucket aliases, operator, UTC | |
| Ledger probe against the locked R2 bucket: `enforced` | PASS / FAIL |
| Conditional create-only write honoured by R2 (probe `createOnly: true`) | PASS / FAIL |
| Delete-capable tokens differ from all others; normal tokens cannot delete evidence in the provider's permission model | PASS / FAIL |
| Request → review → 7-day wait honoured (use a shortened wait only in staging via the two-step policy) → deletion removes both copies | PASS / FAIL |
| Ledger shows started and completed; `verify-ledger` ok | PASS / FAIL |
| Hold placed before execution blocks it; hold released → proceeds | PASS / FAIL |
| Runner killed mid-deletion → visible partial state → resumes | PASS / FAIL |
| Database restored to an earlier point → `reconcile` re-tombstones and removes stale objects | PASS / FAIL |
| A bucket lock rule removal attempt by a non-admin token is refused | PASS / FAIL |
| Workspace erasure blocked while any blocker exists; succeeds only when clear | PASS / FAIL |

Any FAIL blocks production enablement of destructive operations.
