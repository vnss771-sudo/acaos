# PR C — Technician evidence photos: implementation plan

Status: **plan for review. Nothing in this document is implemented or enabled.**
Uploads stay behind a flag that is off everywhere until the owner approves production enablement.

## 0. Decisions already made

| Topic | Decision |
|---|---|
| Primary storage | Railway Storage Bucket (private, S3-compatible), one bucket instance per Railway environment |
| Backup | Separate Cloudflare R2 bucket, independent account and credentials |
| Retention | Configurable per workspace, **7-year default** for job evidence and reports; exceptions and legal holds supported |
| PDF / customer sharing | Out of scope here. They belong to PR D |
| Rollout | Production uploads only after backup, restore and access control are defined **and tested**, and the owner approves |

## 1. Platform facts (checked against Railway docs, 15 Oct 2026)

- Private only; no public buckets. Presigned URLs and multipart uploads are supported.
- $0.015 per GB-month; S3 operations and bucket egress are free. Uploads *from our services* count as normal service egress, so clients upload directly with presigned URLs.
- Encrypted at rest. **No** versioning, object lock, lifecycle rules or server-side encryption options, and **no automatic backups**.
- Public-network access only (no private networking).
- Each environment gets its own bucket and credentials. PR environments cannot reach production objects.
- Free plan: 10 GB-month, then access is suspended until the next cycle. Hobby: 1 TB cap. Pro: unlimited. Passing a Hard Usage Limit also suspends access (data is kept).

Consequences for the design: retention and deletion must be enforced by the application, versioning/lock protection has to come from the R2 copy, and orphan cleanup needs a sweeper job.

### Railway plan check (result)

The Railway account reachable from this session exposes a single **personal** workspace ("Ben Box's Projects", 5 projects including `ACAOS`). The tooling does **not** report plan tier, current usage or the Hard Usage Limit, so **a paid plan is not confirmed**. Before PR C is deployed anywhere: owner confirms in Railway → Workspace → Billing (plan, usage, hard limit) that the workspace is on a paid plan, and sets the hard limit above projected usage. Nothing here assumes it.

## 2. Data model (additive migration, composite FKs like the existing technician tables)

- `JobEvidenceFile`: `id, workspaceId, jobId, evidenceId?, crewMemberId, objectKey, sha256, sizeBytes, contentType, width, height, capturedAt?, status (PENDING | AVAILABLE | REJECTED | DELETED), uploadedAt, retainUntil, backupStatus (NONE | PENDING | VERIFIED | FAILED), backupVerifiedAt, deletedAt`. FKs `(workspaceId, jobId)` and `(workspaceId, crewMemberId)` to match the existing same-workspace guarantees. `@@unique(workspaceId, crewMemberId, submissionId)` for idempotency, same pattern as text evidence.
- `RetentionPolicy` (per workspace): `retentionDays` (default 2555 ≈ 7 years), `evidenceMinimumDays`, `updatedBy`. Per-job extension via `JobEvidenceFile.retainUntil`.
- `LegalHold`: `workspaceId, scope (WORKSPACE | JOB), jobId?, reason, placedBy, placedAt, releasedBy?, releasedAt?`. A file is deletable only if no *active* hold covers it.
- `EvidenceDeletionLog` (append-only): who approved, what, when, which copies (primary and backup) were removed, and checksums at deletion. Rows are never updated.
- All new tables added to `TENANT_MODELS`, and the offline-stub build must pass (annotate Prisma results explicitly).

**Retention effective date** = `max(uploadedAt + policy, any customer-specific minimum, jobClosedAt + policy)`. Whether the clock starts at upload or job closeout is configurable; default is the later of the two.

> The 7-year default is a common baseline, not legal advice. Some records need longer (e.g. certain WHS health-surveillance and construction-defect periods) or shorter, and state rules differ. Legal review of the default and of per-customer overrides is a pre-launch gate.

## 3. Upload flow

1. **Init** `POST /api/ops/technician/:jobId/files/init` — caller must be the *assigned* worker on an *active* job (same checks as text evidence, including the Job row lock). Validates declared `contentType` ∈ {JPEG, PNG, WebP} (HEIC only if decoding is verified in the worker image), size ≤ 10 MB, per-job cap (default 100), per-workspace quota and per-user rate limit. Creates a `PENDING` row and returns a presigned PUT for a **server-chosen key** `ws/{workspaceId}/job/{jobId}/raw/{uuid}` with short expiry (5 min) and the declared content type bound into the signature. Client never supplies a key.
2. **Upload** direct to the bucket (no API egress cost).
3. **Complete** `POST …/files/:id/complete` — enqueues a BullMQ job and returns immediately.
4. **Finalize (worker, not the request path):** `HEAD` to verify size matches and is ≤ limit; stream the object with a hard byte cap; verify **magic bytes** against the declared type; decode with `sharp` using `limitInputPixels` (≈ 25 MP) and a CPU/time budget; **re-encode** to JPEG/WebP at ≤ 2048 px long edge (this drops any embedded payload, polyglot trailer and EXIF/GPS unless explicitly retained, keeping only capture time); write to `…/final/{uuid}`; compute SHA-256; delete the raw object; mark `AVAILABLE` and enqueue backup. Any failure marks `REJECTED` and deletes the raw object.
5. **Sweeper (cron):** delete `PENDING`/raw objects older than 24 h (no lifecycle rules exist on Railway) and reconcile DB rows against bucket listings.

Never trusted: client filename, MIME type, key, EXIF, dimensions. SVG and anything non-raster is rejected. Idempotent per `submissionId`: a retried init returns the same row.

## 4. Access control and isolation

- **No direct bucket access for users.** Reads are API-issued presigned GETs (60–300 s) after authorization: assigned worker (own job) or `ops:manage` in the same workspace. No listing endpoint exposes keys.
- Authorization always re-derives workspace from the caller's membership and requires `file.workspaceId == job.workspaceId == caller workspace`; the object-key prefix is an independent second check. A mismatch is a hard failure and an audit event.
- One bucket per environment, **prefix per workspace** (bucket-per-tenant is unmanageable on Railway). Credentials exist only in the API and worker services; the backup writer uses separate R2 credentials.
- Workers cannot see other workers' files unless they could already see that evidence (existing assigned-job rule); managers see all in their workspace.
- Reports (PR D) will read files only through this same authorized path, scoped by `workspaceId` and `jobId`.

## 5. Backup and restore (must be tested before the flag can be enabled)

- **Replication:** after finalize, a BullMQ job copies the object to R2 under the same key, verifies size and SHA-256 by reading back, and sets `backupStatus=VERIFIED`. The replicator uses a **write-only R2 token (no delete)**.
- **Immutability:** use R2 bucket-level retention/lock rules if available at implementation time (**to verify in R2 docs before building**; if not, restrict credentials so the application cannot delete backups and delete only through the controlled process in §6).
- **Metadata:** the database holds the file→object mapping, so a nightly JSONL manifest per workspace (ids, keys, sizes, hashes, retention, holds) is also written to R2. Postgres backups remain the source of record and are tested separately.
- **Restore tooling:** a script that, for a given workspace/job, finds `AVAILABLE` rows whose primary object is missing or hash-mismatched and restores them from R2, verifying hashes. Supports dry-run.
- **Verification:** weekly sampled integrity check (primary vs backup hash); alert on any `FAILED` or unverified backup older than 24 h.
- **Drill:** a documented restore test against a non-production environment — delete a bucket's objects, restore from R2, confirm every hash — run and recorded before enabling uploads, then quarterly. Proposed targets: RPO ≤ 1 h for new files, RTO ≤ 4 h for a workspace.

## 6. Retention, legal holds and deletion

- A daily job computes `eligible` files (`retainUntil` passed, no active hold, not under a customer minimum) and writes a **deletion proposal report**; nothing is deleted automatically.
- Deletion requires **explicit approval by an owner** (two-step: review proposal → confirm). It removes the primary copy, then the backup copy, verifies both are gone, and appends to `EvidenceDeletionLog`. Failure to delete the backup keeps the row `DELETING` and alerts; it is never silently dropped.
- **Legal hold** (workspace or job scope) blocks both automatic proposals and manual deletion, and is itself audited. Releasing a hold re-enters normal retention.
- **Exceptions:** per-job extension, per-workspace policy, customer-contract minimums, and a documented path for lawful erasure requests that conflict with retention (needs legal sign-off, recorded in the log).
- Workspace closure: files remain until their retention date unless a legal-approved erasure is recorded.

## 7. Cost controls

Assumptions (illustrative, to be replaced with real numbers): 20 technicians × 10 photos/day × 250 days × ~0.6 MB after re-encode ≈ 30 GB/year, ≈ 210 GB over 7 years → about **$3/month on Railway plus about $3/month on R2** at current list prices. Cost is dominated by growth, so:
- Per-file cap, forced downscale/re-encode, per-job file cap, per-workspace quota with alerts at 80 % and a hard stop at 100 %.
- Usage metrics (bytes by workspace, daily growth) on the existing observability stack; alert on abnormal growth.
- Orphan/raw sweeper (§3) so failed uploads don't accumulate.
- Railway Hard Usage Limit set deliberately, because hitting it suspends *all* bucket access including reads.

## 8. UI (technician view)

Add a photo step to the existing note/checklist form using `<input type="file" accept="image/*" capture="environment">`, local preview, per-file progress, retry with the same idempotency key, and clear states (uploading, processing, rejected with reason, saved). Offline queueing is **out of scope**. Manager evidence view shows thumbnails via short-lived URLs.

## 9. Observability and audit

Audit events for init, complete, rejected, downloaded (manager reads), backup verified/failed, hold placed/released, deletion proposed/approved/executed. Sentry for worker failures; counters for rejects by reason.

## 10. Test plan

- **Unit:** magic-byte and type validation (mismatched content type, polyglots, SVG, truncated and zero-byte files), pixel-bomb rejection, key construction, retention date calculation.
- **DB tier (with the tenant guard enforcing):** authorization matrix (assigned worker, other worker, revoked worker, unlinked member, manager, other-workspace manager), cross-workspace attempts at both the route and the database level; races between closeout, revocation and the init or complete steps; quota and rate limits, hold/retention rules, append-only deletion log.
- **Integration:** a MinIO (S3-compatible) service container in CI exercising presign → upload → finalize → backup → restore; failure injection (bucket down, backup failure, worker crash mid-finalize).
- **Abuse:** oversized uploads, expired/replayed presigned URLs, tampered object keys and concurrent duplicate completes.
- **Restore drill** as in §5, recorded as a runbook, not just a test.
- Offline-stub build and `check:tenant-resources` must pass.

## 11. PR sequencing (each separately reviewed; none enables uploads)

1. **C1 — schema:** tables, retention/hold models, tenant registration, deletion log. No endpoints.
2. **C2 — storage layer:** S3 client wrapper, presign/init/complete, finalize worker, sweeper, flag **off**. Local tests against MinIO.
3. **C3 — backup & restore:** R2 replication, manifest, verifier, restore tooling, runbook and a recorded drill in staging.
4. **C4 — retention & holds:** proposals, approval flow, hold management, audited deletion.
5. **C5 — UI:** photo capture and manager thumbnails, still flag-gated.
6. **Enablement (owner decision, not a PR):** staging soak, legal review of retention defaults, Railway plan/limit confirmed, drill passed, then the flag is turned on for one pilot workspace.

## 12. Open items needing the owner

1. Confirm Railway plan, usage and Hard Usage Limit (see §1).
2. R2 account ownership/credentials, and whether to use R2 bucket locks (pending the docs check).
3. Legal review of the 7-year default, start-of-clock rule and any customer-specific minimums.
4. Who is authorised to approve deletions and place legal holds (proposed: workspace owner only).
5. HEIC support (iPhone default format): convert in the worker, or require JPEG capture.
6. Retain EXIF GPS on photos? Proposed default: strip location, keep capture time; make GPS an explicit per-workspace opt-in.
