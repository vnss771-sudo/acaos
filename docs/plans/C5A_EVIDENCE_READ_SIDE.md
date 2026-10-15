# C5a: reading and cancelling technician photo evidence (API side)

Status: implemented for review. **No UI, no client code, no production enablement.** Uploads stay behind `EVIDENCE_UPLOADS_ENABLED` (unset in production) and every endpoint below answers `503` while it is off. No migration: thumbnails use the existing `EvidenceFileCopy` table (`location = 'thumb'` already satisfies the location constraint).

Parent plan: [C5_TECHNICIAN_PHOTO_EVIDENCE_PLAN.md](C5_TECHNICIAN_PHOTO_EVIDENCE_PLAN.md). Product decisions applied here: technicians read **only their own** evidence **only while assigned to an ACTIVE job**; managers keep access to historical evidence; no captions; existing upload limits unchanged.

## Endpoints (all under `/api/ops/technician`, all `requireAuth`, all fail closed)

| Route | Who | Behaviour |
|---|---|---|
| `GET /:jobId/files?workspaceId&limit&cursor` | technician (own files) or `ops:manage` | Keyset-paginated (`createdAt desc, id desc`), `limit` 1 to 100. Managers see `AVAILABLE` files only, with `uploadedBy {crewMemberId, name}`. Technicians see their own `PENDING`/`AVAILABLE`/`REJECTED` files (so the app can reconcile its queue after a reload). `DELETING`/`DELETED` are never listed. Returns `hasThumb`, never an object key. `Cache-Control: no-store`. |
| `GET /:jobId/files/:fileId/content?workspaceId&variant=full\|thumb` | same | `AVAILABLE` files only. Returns `{ url, expiresAt, variant }`: a presigned GET valid for at most **60 s**, with the response type (`image/jpeg`), `inline` disposition and `private, no-store` forced by the signature rather than taken from object metadata. Audited as `ops.technician.file.viewed`. `no-store` on the API response. |
| `DELETE /:jobId/files/:fileId` (scope in body or query) | owning technician | Cancels the technician's **own `PENDING`** upload by a compare-and-set to `REJECTED`. The API never deletes objects (the C4 boundary check still forbids it); the worker sweeper removes the leftovers. `AVAILABLE` evidence returns `409`: removing it is retention/legal-hold governance (C4), not a technician action. Idempotent. Audited as `ops.technician.file.cancelled`. |
| `GET /assigned` | technician | Gains `photos: boolean` (server capability only), so the UI can hide the Photos tab instead of discovering a `503`. `false` when the technician has no linked crew record. |

Per-user rate limits: 120/min for list and content, 30/min for cancel.

### Authorisation matrix (tested in `tests-db/evidence-file-read.test.ts`)

| Caller | list / content | cancel |
|---|---|---|
| Owning technician, assigned, job ACTIVE | own files | own `PENDING` only |
| Same technician, job closed | `409` | allowed while still assigned (cleanup) |
| Same technician, assignment revoked | `403` | `403` |
| Another technician (even on the same job) | their own files only; a colleague's file id is `404` | `404` |
| Workspace member not assigned to the job | `403` | `403` |
| Manager (`ops:manage`) | every `AVAILABLE` file on any job in the workspace, including closed jobs | `403` (no crew link; managers use governance) |
| Manager of another workspace, or a non-member | `403` | `403` |
| Unauthenticated | `401` | `401` |

Another technician's file, a file on a different job and a file in another workspace all look the same as a missing file. A copy record whose key is outside `ws/<workspace>/job/<job>/` is never signed (`assertKeyForJob`).

## Thumbnails

* At `init` a third copy row is recorded, `location = 'thumb'`, `PENDING`, with a key **derived from the final key** (`…/final/<r>` becomes `…/thumb/<r>`). Recording it up front means every existing cleanup path (reject, sweeper, C4 deletion runner's leftover loop) already knows the key. Re-running finalisation rewrites the same object.
* The worker makes a 320 px (long edge) JPEG from the **already sanitised** bytes, writes it, verifies its size, and marks the copy `VERIFIED` in the same transaction that flips the file to `AVAILABLE`. A thumbnail failure never blocks the evidence: the copy stays `PENDING`, `hasThumb` is `false`, and the gallery falls back to the full image.
* If the commit loses a race (job closed, assignment revoked, another worker won), the thumbnail object is deleted together with the final object.
* Thumbnails are **not backed up** (they are derived and rebuildable from the backed-up final object); the C3 backup, verifier, manifest and restore code select copies by `location` and are unaffected. The C4 deletion runner removes them with the file (`tests-db/evidence-governance.test.ts` asserts it).

## Security notes

* Presigned GET URLs are bearer credentials: 60 s TTL, never logged, `no-store` everywhere, not stored by the server. The API response contains only the URL and its expiry.
* Only worker-re-encoded JPEGs are ever served, with the type forced by the signature (`response-content-type`), so a stored object cannot be coerced into active content. EXIF/GPS were removed at finalisation (the served bytes are tested to carry none).
* No endpoint returns an object key, bucket name or provider detail.
* Technicians have no read path to closed-job evidence or to anyone else's evidence; managers have no write path here.
* Residual items unchanged by this PR: malware scanning (release gate), provider-level credential isolation (C4b), CORS for browser uploads and signed-PUT behaviour in real browsers (C5.0).

## Contracts

`packages/shared` adds typed contracts for the mutating routes (`files/init`, `files/:fileId/complete`, `DELETE files/:fileId`) and exports the response types for the list and content endpoints (`EvidenceFileSummary`, `EvidenceFileListResponse`, `EvidenceFileContentResponse`). GET routes are called with the plain `api` hook, as elsewhere; `check:frontend-mutations` is satisfied.

## Operational impact and rollback

* No migration and no new environment variable. With uploads disabled nothing changes.
* The `check:evidence-delete-boundary` rule against `.delete(` in the upload routes now ignores Express `Router.delete(...)` registrations (HTTP verbs) and still rejects store deletions (verified by temporarily inserting one).
* Rollback = revert the PR. Existing `thumb` rows left by a rollback are harmless (`PENDING`/`VERIFIED` copies of files that still own them) and are removed by the same cleanup paths as any other copy.

## Tests

* Unit: signed-GET parameters on the real presigner, forced-header behaviour of the memory store, thumbnail key derivation and thumbnail generation (`tests/evidence-storage.test.ts`).
* DB tier (tenant guard enforcing), `tests-db/evidence-file-read.test.ts`: fail-closed behaviour and the `photos` flag, thumbnails produced/cleaned/failing safely, list scoping and pagination, the authorisation matrix, closed job and revocation, 60 s TTL and expiry, forced headers, cross-technician/job/workspace refusals, corrupted-key refusal, audit events, cancel semantics and the cancel-versus-finalise race. Updated `evidence-upload-security` and `evidence-governance` tests for the extra copy.
* Real S3-compatible server (opt-in `ACAOS_S3_IT=1`): the signed GET serves the sanitised bytes with the forced headers, the thumbnail is real, a tampered key and an unsigned URL are refused. The existing C3 real-S3 tests (1 to 9) still pass with the extra copy row.
