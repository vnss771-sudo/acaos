# C4: retention, legal holds and controlled deletion

Status: implemented behind flags, **review-only**. Nothing is provisioned, enabled or deployed. Destructive operations are off by default, automatic deletion stays off, and no ledger or delete credentials exist anywhere.

## What C4 adds

| Area | Where |
|---|---|
| Owner-only policy, hold and deletion-request endpoints (`/api/ops/evidence-governance/*`, permission `evidence:govern`, owners only) | `apps/api/src/routes/ops/evidenceGovernance.ts` |
| Two-step deletion with a waiting period, sealed approvals, DB-enforced rules | `EvidenceDeletionRequest` (migration `20261017000000_evidence_governance`) |
| The only process that deletes evidence: resumable executor, reconciliation, runner cycle | `apps/worker/src/processors/evidenceDeletion.ts`, `scripts/evidence-deletion.ts` |
| External deletion ledger (create-only, hash-chained, MAC-signed) and an immutability probe | `packages/backend-core/src/lib/evidenceLedger.ts` |
| Shared rules (governance lock, retention, seals), configuration, erasure gate | `evidenceGovernance.ts`, `evidenceDeletionConfig.ts`, `evidenceErasure.ts` |
| Boundary check and CI additions (sharp smoke on the real worker image) | `scripts/check-evidence-delete-boundary.mjs`, `.github/workflows/ci.yml` |

## Rules, in one place

1. **Owners only.** Retention policy, legal holds and every step of a deletion request require `evidence:govern`, held by workspace owners alone (not admins), and every object is looked up by `(workspaceId, id)`.
2. **Two steps plus a wait.** An owner *requests*; an owner *reviews* (approves); the earliest execution is `reviewedAt + waitDays`. The default is **7 days**, from `RetentionPolicy.deletionWaitDays`. Lengthening it is immediate; **shortening is two-step** (pending value, confirmed after a 24 h cooling-off). A workspace may require a *different* owner to review (`requireDistinctReviewer`). The wait is snapshotted at review time and the database CHECK rejects `notBefore < reviewedAt + waitDays`.
3. **Approvals are sealed and expire.** The review writes an HMAC over (request, workspace, file, job, file hash, reviewer, times, wait) with `EVIDENCE_DELETION_SEAL_KEY`. The runner verifies it; a row flipped to APPROVED by SQL, a restored/tampered database, or a seal copied from another request is inert. An approval not executed within 30 days of the wait ending is cancelled, not run.
4. **Holds win.** A workspace or job legal hold blocks request, review and execution. Hold changes and the start of a deletion take the same per-workspace advisory lock, so they serialise: whichever commits first wins, and a deletion already started is never silently abandoned (it halts visibly if a hold arrives mid-way and resumes after release). A hold cannot protect a file whose deletion has already started; the API says how many such files exist.
5. **Retention is enforced, not overridable.** A file is deletable only when its effective retention has passed (`retentionDays`, start rule, job closed; an unclosed job means "cannot be determined" = retained). The API cannot shorten retention or enable automatic deletion; `autoDeletionEnabled` stays false and nothing reads it. There is **no retention-override path** (see the legal section).
6. **Destructive flag.** `EVIDENCE_DESTRUCTIVE_ENABLED` (exactly `true`) plus the seal key gate request/review and the whole runner, independent of the upload and backup flags. Protective endpoints (policy, holds) work regardless.
7. **Credential separation.** Delete-capable tokens (`EVIDENCE_DELETE_PRIMARY_*`, `EVIDENCE_DELETE_BACKUP_*`) exist only in the deletion runner, must differ from the normal and ledger tokens, and the upload and backup resolvers disable their service if any `EVIDENCE_DELETE_*` variable is present in it. A static check keeps other modules from referencing them. See limits below.
8. **Resumable and visible.** The runner moves APPROVED → EXECUTING and the file AVAILABLE → DELETING under the lock, writes `FILE_DELETION_STARTED` to the ledger *before* touching any object, deletes the primary then the backup (re-checking holds before each and verifying absence with a HEAD), writes `FILE_DELETION_COMPLETED`, and only then marks copies/file DELETED and the request COMPLETED in one transaction (plus the database deletion-log row). Any failure leaves the request EXECUTING with a short `lastError`, an attempt count and the file DELETING; a stuck count is logged at error level. Re-running resumes; every step is idempotent.
9. **Tombstones that survive restores.** The ledger (outside PostgreSQL) records every deletion and every hold placement/release. Each runner cycle first reconciles the database against it: ledger-completed deletions are re-applied (stale objects removed, row re-tombstoned, any reopened request closed), a started-but-unfinished one is resumed unless a hold now covers it (reported as a conflict instead), holds lost by a restore are recreated, and holds the ledger shows released are ended. It never undeletes anything. Forged ledger entries (bad MAC) are reported and ignored.
10. **Workspace erasure.** `DELETE /api/workspaces/:id` still needs owner + step-up + typed name, and now additionally: no active hold, every hold placement/release in the ledger, every file DELETED, no open request, and the ledger confirms each deletion. It re-checks the database blockers under the governance lock, appends `WORKSPACE_ERASED` to the ledger *before* removing rows, then removes the evidence rows with the workspace. The permanent record is the ledger and the FK-free `EvidenceDeletionLog`. Workspaces without evidence erase exactly as before; with the deletion flag off the previous refusal applies.

## What the ledger does and does not guarantee

- **Does:** create-only objects under keys never reused, MAC-signed, per-workspace hash chain (a removed or altered entry is detectable, `verifyChain`), idempotent appends, and a probe that measures what the configured credential can actually do (second create, overwrite, delete). The runner refuses to run unless the probe says **enforced**.
- **Does not:** make the data immutable by itself. Immutability is a property of the provider and the credential. Removal of the *newest* chain entries is undetectable without an external anchor. The probe proves *this credential* cannot overwrite or delete, not that the provider's account owner cannot.
- **Provider facts checked (docs, 15 Oct 2026):**
  - **Railway Buckets** list *object locks* and *object versioning* as **not supported**, so a Railway bucket cannot be the ledger.
  - **Cloudflare R2 bucket locks** (GA March 2025) let a rule on a prefix, or the bucket, retain objects for a duration, until a date, or **indefinitely**, preventing delete **and overwrite**, including by tokens with write permission. Rules are set by account administrators and can be removed by them ("until the lock is explicitly removed"), so this is tamper-resistant against a leaked token, not against the account owner. As far as I could determine, R2's API token permission levels are read/write at object or admin scope with no create-only level (not re-verified against the token documentation in this session), which is why the lock rule, not the token, provides the protection and why the probe measures the effective result.
  - Not verified against a real R2 account: conditional `If-None-Match` writes on R2 (the probe reports `none` if they are not honoured, which blocks the runner), and the exact lock behaviour on the `v1/` prefix. **The staging drill must run the probe against a real R2 ledger bucket with a lock rule and record the result.** On the local S3-compatible server used in tests the probe reports `create_only` (it cannot enforce), and the gate correctly refuses to run.

## Hard-to-reverse decisions (please confirm before merge)

1. **The ledger is permanent by design.** An indefinitely locked bucket cannot be emptied or have entries erased. Entries hold workspace, file, job and user ids (pseudonymous identifiers), content hashes and timestamps; no names, contact details or file content. Whether that is compatible with a data-subject erasure request is a **legal question** (below).
2. **Ledger key layout `v1/ws/<workspace>/…` and entry formats** become the permanent record. The version prefix allows a `v2` but old entries are never rewritten.
3. **Table `EvidenceDeletionRequest` and its CHECKs** are additive and rollback-able *only while no request has executed* (rollback SQL included); after the first real deletion the ledger is the history and the table must be kept.
4. **No retention override.** A file under retention cannot be deleted by any path. A lawful early erasure (e.g. a customer erasure request that conflicts with the minimum period) needs a documented legal exception process that does not exist yet; adding one later is additive.
5. **Primary is deleted before backup.** A mid-way stop leaves a recoverable backup, at the cost of a window where only the backup holds the file.

## Unresolved legal and policy questions (not decided by this PR)

- Whether the seven-year default, its start rule (later of upload and job closeout) and any customer-specific minimum are correct for Australian record-keeping and the customer contracts. Until reviewed, the default is conservative (long) and cannot be shortened through the API.
- A lawful path for erasure requests that conflict with retention (needs counsel; recorded in the ledger).
- Whether pseudonymous identifiers in an immutable ledger are acceptable, how long the ledger and independent database dumps may keep information about erased subjects, and the retention of backups taken before a deletion.
- Who, besides workspace owners, may ever authorise deletion (support staff on behalf of a customer); C4 gives them nothing.
- Whether the 24 h cooling-off and 7-day wait are sufficient, and whether a second *distinct* owner should be mandatory rather than an option (it cannot be for single-owner workspaces).

## Limits of this implementation

- **Provider-level permission separation is deployment work.** On one primary bucket the upload/finalise worker needs delete rights on `upload/` staging keys, and R2/Railway tokens are per bucket, not per prefix. The code never deletes AVAILABLE evidence outside the runner (and a static check enforces the credential boundary), but the provider cannot be told "no deleting `final/`" with a bucket-wide token. To get true separation, stage uploads in a separate bucket (a follow-up) or accept the code-level boundary.
- The runner is a single process; concurrent runners are safe (idempotent steps, ledger conflicts detected) but not designed for throughput.
- The API ledger client appends holds on a best-effort basis (a ledger outage never prevents placing a hold; the runner syncs them, and erasure refuses while any is unledgered). A database restore *before* a hold is ledgered loses it.
- No UI. No bulk or scheduled deletion proposals (automatic deletion remains out of scope).
- Real-provider behaviour (R2 lock, conditional writes, token permissions, Railway bucket delete semantics) is untested; see the runbook's staging drill.
