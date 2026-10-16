# C3 post-merge verification: evidence report

Verified against `master` at `99c6f5a14383ab3d321dcd9dda75a604365a21d8` (merge of PR #401), 15 Oct 2026. Nothing was provisioned, deployed or enabled; no production credentials were used. "Disposable" servers below are local containers with throwaway credentials that no longer exist.

Legend: **PASS** verified here · **PASS\*** verified with a stated limitation · **FAIL** · **OPEN** not verifiable here / needs the owner.

## Summary

| # | Item | Result |
|---|---|---|
| 1 | Merged commit and required CI | **PASS** |
| 2 | Restore overwrite races | **FAIL found, fixed, PASS after fix** (this PR) |
| 3 | Retries, checksum mismatch, audit, worker interruption | **PASS** (one gap closed: `primary_missing` now alerts) |
| 4 | Real S3-compatible primary + backup servers | **PASS\*** (SeaweedFS, not R2/Railway) |
| 5 | Alpine production worker image and sharp | **PASS\*** (x64; `apk` step not runnable here) |
| 6 | Independent PostgreSQL backup and recovery | **Documented; OPEN** (not provisioned or drilled) |
| 7 | Uploads and backups disabled in production | **PASS** (nothing is deployed; no flags set) |
| 8 | Unresolved issues and prerequisites | see the end |

## 1. Merged commit and CI: PASS

- `PR #401`: merged by `vnss771-sudo` at 2026-10-15T14:00:36Z. Merge commit `99c6f5a`; PR head `cc380c6`.
- `git diff cc380c6 99c6f5a --stat` is empty: the merged tree is exactly the tree tested before merge.
- All 18 checks on the PR head were `success`: required, CodeQL, Analyze, Docker image (api, worker, web), Standalone build (api, worker), Production build, Governance, Redis integration, Database integration, Forward-compat (Node 26), Browser smoke, Static and unit gates, Deterministic offline build, Secret scan, Dependency review.
- Post-merge `CI` run on `master` (run 38747601087) concluded `success`.

## 2. Restore overwrite races: FAIL found and fixed

**Finding (merged C3).** Restore checked "primary is missing/corrupted", staged, re-checked, then did a plain `putBytes` to the primary key. Between the last check and the write another writer (a second restore, an operator) could create or change the object and restore would overwrite it. When the competitor wrote the same verified bytes the effect was harmless; when it wrote anything else, or when a file's record changed mid-restore, restore overwrote it anyway. The earlier "re-check before promote" narrowed the window but did not close it, which S3 cannot do without a conditional write.

**Fix (this PR).**
- `EvidenceObjectStore` gains `getBytesWithEtag` and `putBytesIf` (S3 `If-None-Match: *` when the primary was missing; `If-Match: <ETag inspected>` when corrupted). A failed precondition (412/409) never overwrites: if the object is now valid restore reports `primary_valid`, otherwise it stops with "primary object changed during restore; re-run".
- The file record is re-read just before promotion (still `AVAILABLE`, same SHA-256, backup still `VERIFIED`).
- A corrupted primary whose ETag cannot be read (oversize) is refused rather than replaced blindly.

**Evidence.**
- New tests in `tests-db/evidence-backup.test.ts` (36 tests, all pass): 8 concurrent restores of a missing primary produce exactly one `restored` and one write to the key; 6 concurrent restores of a corrupted primary replace it exactly once; an object injected between inspection and write is never overwritten (valid → `primary_valid`, invalid → refused and untouched); a changed or deleted corrupted object defeats the ETag match; a record changed during staging aborts.
- Mutation check: replacing the conditional write with the old plain write makes **5 tests fail** (`concurrent… missing`, `concurrent… corrupted`, `appears between…`, `ETag match`, `failed staged copy…`); restored afterwards.
- Real server: `conditional writes are enforced by the real server` and `concurrent restores against the real server write the primary once` pass on SeaweedFS (section 4).

**Limit.** The protection depends on the provider enforcing S3 conditional writes. SeaweedFS does. **Railway buckets and Cloudflare R2 are unverified**; the drill runbook now makes that test step 0. If a provider ignores the headers, restore degrades to the pre-fix behaviour.

## 3. Retries, mismatches, audit, interruption: PASS

Already covered in merged tests and re-run: transient failure → `FAILED/transient`, attempts counted, retry verifies, last attempt returns instead of throwing; `primary_mismatch`, `backup_conflict` (foreign object never overwritten), `readback_mismatch` for appended/truncated/flipped bytes; stale worker cannot mark `VERIFIED` after the file changes; concurrent duplicates converge on one copy.

Added here:
- Audit: `backup_verified` and `backup_incident` (with `code`) are written, metadata contains no object keys. Restore writes `restore_started` before any change, `restore_completed` after, `restore_refused` on denial, and is refused if the audit row cannot be written (tested by making `auditEvent.create` throw).
- Gap closed: `primary_missing` (a vanished primary object for an AVAILABLE file) was retried quietly. It is now an integrity code, so the sweep reports it every run until resolved.
- Genuine process death: `tests-db/helpers/crash-child.ts` runs a worker operation in a child process that `SIGKILL`s itself right after the backup object (or the final object) is written. Parent then shows the copy left `VERIFYING` (attempts 1) with the object present; the sweep does not requeue before the 15-minute retry window, does after it; the retry ends `VERIFIED` (attempts 2). For finalisation: file stays `PENDING`, rerun finalises it.
- Limitation: the sweep's alerting is log-based (`error` level, counts only). There is no pager wiring in the repo for these lines; that is an owner prerequisite.

## 4. Real S3-compatible primary and backup: PASS\*

Two separate SeaweedFS servers (`chrislusf/seaweedfs`, local Docker, different ports, credentials and buckets), configured through the real `EVIDENCE_*` / `EVIDENCE_BACKUP_*` settings; stores are the real AWS-SDK S3 adapter (no in-memory fakes). Suite: `tests-db/evidence-s3-integration.test.ts` (skipped unless `ACAOS_S3_IT=1`).

```
ACAOS_S3_IT=1 ACAOS_S3_IT_BACKUP_CONTAINER=<backup container> \
  EVIDENCE_UPLOADS_ENABLED=true EVIDENCE_S3_ENDPOINT=http://127.0.0.1:19000 EVIDENCE_S3_FORCE_PATH_STYLE=true EVIDENCE_S3_BUCKET=it-primary EVIDENCE_S3_ACCESS_KEY_ID=… EVIDENCE_S3_SECRET_ACCESS_KEY=… EVIDENCE_S3_REGION=us-east-1 \
  EVIDENCE_BACKUP_ENABLED=true EVIDENCE_BACKUP_ENDPOINT=http://127.0.0.1:19100 EVIDENCE_BACKUP_BUCKET=it-backup EVIDENCE_BACKUP_ACCESS_KEY_ID=… EVIDENCE_BACKUP_SECRET_ACCESS_KEY=… EVIDENCE_BACKUP_REGION=us-east-1 \
  npm run test:db:local   # (with the file list narrowed, or: tsx --test tests-db/evidence-s3-integration.test.ts)
```

Result: **9/9 pass**:
1. API init → real HTTP PUT to the presigned URL → complete → finalize (EXIF/GPS gone, JPEG) → replicate → read-back SHA equals primary → primary object deleted → dry-run (`would_restore`, nothing changed) → non-owner refused → owner restore → SHA-256 and length identical → rerun `primary_valid`.
2. Presigned PUT enforced by the server: extra bytes, wrong `Content-Type` and a different key are refused; the exact signed request succeeds.
3. Conditional writes enforced (create-only, stale ETag, current ETag, `If-Match` on a missing object does not create).
4. Five concurrent restores: exactly one `restored`, rest `primary_valid`.
5. Backup object corrupted behind our back: verifier flags it, replication reports `backup_conflict`, object left untouched, incident audited.
6. Tampered primary is never copied.
7. Network interruption: backup container stopped → replication throws, row `FAILED/transient`, last-attempt returns `failed`; container restarted → retry `VERIFIED`.
8. and 9. SIGKILL recovery (section 3).

**Not covered.** This is SeaweedFS, not Railway Storage Buckets or Cloudflare R2. Provider-specific behaviour (conditional-write support, ETag format, checksum headers, error codes, eventual consistency, TLS, the R2 hostname allow-list) is untested. The loopback-`http` allowance used here is refused in production by design.

## 5. Alpine production worker image and sharp: PASS\*

- Built from the repo's `Dockerfile.worker` (base `node:26-alpine@sha256:0b36e8c1…`, Node v26.10.0, Alpine) with `docker build`. Two deviations, both forced by the sandbox: the two `apk add --no-cache openssl libc6-compat` lines were removed (Alpine mirrors are unreachable from here; the base image already provides `libssl3`/`musl`), and the egress proxy's CA was injected so `npm` could reach the registry. Neither affects sharp.
- Run as the image's unprivileged user (uid 1000) with `--network none` against the compiled `backend-core/dist/lib/evidenceImage.js`: sharp 0.35.5 / libvips 8.18.7 loaded from the musl prebuilt (`@img/sharp-linuxmusl-x64`); JPEG, PNG and WebP with GPS EXIF re-encode to a 640×480 JPEG with **no EXIF** and the copyright string absent; a 36 MP image → `too_many_pixels`; a JPEG with a trailing `<?php …` payload → payload dropped; PNG declared as JPEG → `type_mismatch`; GIF/garbage → `unsupported_type`. `SMOKE PASS`.
- **Not verified:** the unmodified `apk` step; arm64; the worker's startup against Redis/Postgres in the container; resource limits under Railway.

## 6. Independent PostgreSQL backup and recovery: documented, OPEN

`docs/runbooks/EVIDENCE_POSTGRES_RECOVERY.md`: why the database is the single point of attribution/verification, the gate (provider backups with confirmed PITR, an independent logical dump with write-only credentials, measured RPO/RTO for DB + objects, tested restore, monitoring), recovery scenarios A–D (DB lost; objects lost; both; restored DB resurrecting deleted data), reconciliation SQL, and the erasure/dump-retention interaction. Not provisioned and not drilled. Railway's actual backup/PITR features for the plan are **unverified**.

## 7. Production state: PASS

Read-only checks through the Railway connector (nothing changed):
- Project `ACAOS` (`501e71c0…`), environment `production`: one service `acaos`, state `staged-create`, **no deployments**, no volumes, **no buckets**; one unapplied staged change (create service from `vnss771-sudo/acaos@master`, staged 2026-10-10). Variables on that service: only Railway system variables. **No `EVIDENCE_*` variable exists.**
- In code, both features resolve to disabled unless the flag is exactly `true` and the config is valid (unit and DB tests: unset, `false`, `yes`, half-configured, shared-bucket/credential/non-R2 endpoint all stay off; nothing is read or written).
- **Limit:** this shows nothing is running on this Railway project. It cannot show that no other host (another project, Vercel, a local machine) is serving ACAOS. Confirm where production actually runs and that those environments carry no `EVIDENCE_*` variables.

## 8. Unresolved security issues and prerequisites

**Security / design (not blocking these tests, but decide before enabling):**
1. **Credential separation is deployment-level, not code-level.** The spec says the backup worker has read-only primary access; today one worker process runs finalisation (primary write) and backup replication (primary read + backup write). Run backup replication as a separate service with a read-only primary credential and a no-delete R2 token, or accept the wider blast radius. *(Correction 2026-10-16: a no-delete R2 token is not available with R2's documented token levels; this is open risk R-1 in `EVIDENCE_OPEN_SECURITY_RISKS.md`.)*
2. **Restore trust boundary.** The owner-approval check is application-level; whoever holds database and bucket credentials can bypass the CLI entirely. Restore credentials must be short-lived and issued per drill.
3. **Conditional-write dependence** (section 2) must be proven on Railway and R2.
4. **Incident visibility** relies on log lines and a best-effort audit write (`recordAudit` swallows failures); no alert routing exists yet.
5. **Orphans.** A restore process killed between staging and cleanup leaves an object under `…/restore/` that nothing sweeps; backups and primary are unencrypted at rest beyond provider defaults (Railway buckets have no SSE/versioning/object lock per earlier research).
6. **Malware scanning** is still undecided; backups copy whatever finalisation accepted.
7. Backup content type is fixed to `image/jpeg` (matches finalisation); HEIC/other types need a revisit.

**Infrastructure and owner prerequisites (all OPEN):** Railway plan, usage limits and bucket features confirmed from the dashboard; R2 account ownership, scoped no-delete tokens, and whether bucket locks exist; staging buckets approved for the real drill (`EVIDENCE_RESTORE_DRILL.md` step 0 onward); independent PostgreSQL backup provisioned and drilled; alert routing for the integrity and 24 h-unverified log lines; legal review of the 7-year default and of backup retention vs erasure; controlled erasure design (C4) including a write-once deletion record outside PostgreSQL; unmodified Alpine `apk` build and arm64/Railway smoke; real-device Android/iOS test of the technician UI.

## Gates run on this branch (post-fix)

| Command | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck:{shared,backend-core,api,web,worker}` (real Prisma client) | clean |
| Same three server typechecks with the offline Prisma stub | clean |
| `check:boundaries`, `check:worker-processors`, `check:frontend-mutations`, `check:test-tiers`, `check:critical-test-coverage`, `check:offline-stub` | pass |
| `npm run test:coverage` (unit) | 2283/2283 pass; functions 87.19% (gate 87) |
| DB tier, `TENANT_GUARD_MODE=enforce` (`scripts/with-tenant-guard.sh`), integration suite skipped | 656 pass, 9 skipped, 0 fail; `migrate diff`: no drift |
| DB suites re-run with the integration env present (`evidence-backup`, `evidence-s3-integration`, `evidence-upload-security`, `evidence-file-schema`) | 87/87 pass, 0 skipped |
| Not run here | Node 26 host build, CodeQL, secret scan (CI), Docker `apk` step |
