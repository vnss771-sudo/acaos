# C5b: on-device image pipeline, persistent queue and upload engine

Status: implemented for review. **No UI** (the technician screen is C5c), **no server change**, no migration, no new environment variable. Production evidence uploads stay disabled (`EVIDENCE_UPLOADS_ENABLED` is unset in production, so the server answers 503 and the app's `photos` flag is false). Design inputs: [C5_TECHNICIAN_PHOTO_EVIDENCE_PLAN.md](C5_TECHNICIAN_PHOTO_EVIDENCE_PLAN.md) and the measured browser behaviour in [C5_0_BROWSER_UPLOAD_FINDINGS.md](C5_0_BROWSER_UPLOAD_FINDINGS.md).

Everything lives in `apps/web/src/lib/evidence/` and reuses the existing C2 `init`/`complete`/status routes and the C5a cancel route through the typed route client (contracts in `packages/shared`). No second evidence system.

## Modules

| Module | Role |
|---|---|
| `imageFormat.ts` | Byte-level helpers: real format from magic bytes (JPEG/PNG/WebP/GIF/HEIC/AVIF), header dimensions, EXIF orientation, **removal of every JPEG metadata segment** (EXIF/GPS, XMP, ICC, IPTC, comments), and a check that none remain. |
| `imagePipeline.ts` | `prepareImage`: input caps, format check, pixel-bomb check from the header, decode, scale (long edge ladder 2560/2048/1600/1280), JPEG quality ladder, output size cap (10 MiB), metadata strip and verification, SHA-256. Throws `ImageError` with a fixed, person-readable message. |
| `imageCodec.ts` | The browser implementation (`createImageBitmap` with the EXIF orientation applied by the decoder, resized at decode time when the header size is known, canvas on a white background, fall back to a full decode if the browser returns an unexpected shape). |
| `queueStore.ts` | The persistent queue: `IndexedDbQueueStore` (one database for the origin, rows keyed by user and workspace) and `MemoryQueueStore` for tests. Caps and duplicate detection are enforced inside the insert transaction. |
| `uploadEngine.ts` | The state machine, retries, concurrency, cancellation and resume. All environment is injected. |
| `uploadErrors.ts` | Failure classification into short codes, dispositions (retry / pause for sign-in / final) and the fixed texts shown to the person. |
| `uploadTransport.ts` | `xhrPut`: one XHR PUT with progress, timeout and abort; sets only `Content-Type`. |
| `createUploader.ts` | Browser wiring: IndexedDB store, XHR, Web Locks across tabs, `online` / `focus` / `pageshow` / `visibilitychange` resume, and `purgeAllQueuedPhotos` for sign-out. |
| `evidenceApi.ts` | Adapter from the app's authenticated client to the engine's API (mutations via `route(...)`, status via a read). |
| `ApiRequestError` (in `hooks/useApi.ts`) | Every non-OK response is now thrown as an `Error` subclass carrying `status` and `code` (message unchanged), so the engine can classify failures without parsing text. |

## Photo life cycle

```
add photo -> prepareImage -> persisted in IndexedDB (state queued, id = submissionId)
queued     -> init (idempotent on submissionId) -> PUT to the signed URL -> processing
processing -> complete (idempotent) -> poll status -> done (AVAILABLE) | rejected (REJECTED)
retryable failures: queued again with jittered exponential backoff (2 s base, 5 min cap)
after 8 automatic attempts: failed (a person presses Retry, which resets the budget)
final failures: rejected (the photo is dropped from the device; the reason code is kept)
cancel: abort the PUT, mark cancelling, DELETE the pending server record (retried until it succeeds), remove locally
```

### Safe retries and "no duplicate evidence"

* `id` is a UUID generated once, when the photo is added, and **persisted**. It is the `submissionId` for every `init` of that photo, whatever happens (retry, reload, second tab, lost response). The server already guarantees one file per `(workspace, crew member, submissionId)`; nothing new was needed server-side.
* The processed JPEG is stored in the queue and **never re-encoded on a retry**: the signature binds the exact size and type, so a re-encode would be a hard 403.
* `complete` is idempotent, and completion is decided by the **server status** (`AVAILABLE`), not by counting PUT attempts (Chromium may transparently repeat a PUT after a dropped connection; harmless because it is the same key and the same bytes).
* A storage 403 (expired signature, wrong size and wrong type all look alike) triggers **one** fresh `init` and PUT; a second 403 is final (`upload_rejected`). `complete` answering "upload not found" sends the photo back to upload at most twice.
* Adding the same photo twice for the same job is refused as a duplicate unless the person confirms (`allowDuplicate`); enforced atomically with the other caps.
* If the server already holds the file as `AVAILABLE`/`REJECTED` (a lost response), the engine adopts that state without a second upload.

### Failure handling

| Failure | Behaviour |
|---|---|
| Network error, timeout, 5xx, 429 | Retry with backoff. While `navigator.onLine` is false no attempt is spent. |
| 503 "uploads not enabled" | Long pause (5 min), no attempt spent. |
| 401 | The photo stays queued; the engine pauses until the signed-in user changes (signing in again resumes at once) or 30 s pass. |
| 403 / 404 / 409 job closed or limit / 413 / 400 / conflict | Final: `rejected`, the photo is dropped from the device, a fixed explanation is shown. |
| Worker rejects the file | Final: `server_rejected`. |
| Processing still pending after 3 min | Not a failure: look again in 30 s without spending an attempt. |
| Storage or quota error on the device | Reported as `storage_full`; never a thrown error into the UI. |

Coming back online or to the foreground (`online`, `focus`, `pageshow`, tab visible) calls `resume()`, which clears retry delays (except the "uploads off" pause) and pumps the queue immediately. At most 2 uploads run at once; Web Locks keep two tabs from working on the same photo (server idempotency still protects browsers without Locks).

## Privacy, isolation and secrets

* **Per account and workspace.** Each record belongs to one `(userId, workspaceId)`; every store method takes the scope and can only reach its own records (same ids in different scopes do not collide; a record carrying another scope is refused). The engine refuses to make any request unless `sessionUserId()` equals the queue's user, so nothing is ever uploaded under a different account. `purgeAllQueuedPhotos()` wipes the whole database for sign-out; `engine.unsent()` returns the count and bytes to warn about before that (and before switching workspace).
* **No secrets at rest or in logs.** Signed URLs and headers exist only in memory for one attempt. The queue stores bytes, size, hash, state and a short **error code** (never raw error text); the engine's log hook receives only codes and a shortened id; the snapshot given to the UI contains fixed texts. Tests scan the persisted rows, logs and snapshot for `X-Amz`, signatures, credentials, hostnames and tokens, in unit tests and in a real browser.
* **Strict limits** (`limits.ts`): 60 MB input, 10 MiB upload (matches the server), 120 MP decode cap, 30 queued photos and 120 MB per scope, 2 concurrent uploads, 8 automatic attempts. The server remains authoritative and enforces its own.
* **EXIF/GPS.** Dropped three ways: canvas re-encode, the explicit JPEG segment stripper (verified on the output), and the server's re-encode. v1 stores no location.
* **Previews.** The UI must show previews as `data:` URLs (`FileReader.readAsDataURL` on `engine.preview(id)`); `blob:` is not in the CSP and was deliberately not added.

## HEIC / HEIF

No server-side HEIC processing. The pipeline recognises HEIC/HEIF/AVIF by their bytes; where the browser can decode it (for example Safari) it converts like any photo; where it cannot, the person sees: *"This phone could not convert that HEIC/HEIF photo. Take the photo again with the camera, or change the camera format to "Most Compatible" (JPEG) and try again."* Nothing is queued and no server record is created. (A header-only HEIC fixture exercises the failure path in Chromium; real HEIC decoding on iOS Safari is a C5e real-device item.)

## Tests

* **Vitest (unit tier of the web app), 94 tests in `lib/evidence`, 129 with the API-client tests:** format sniffing, header dimensions, orientation, metadata stripping on synthetic JPEGs with EXIF/GPS/XMP/ICC/comments; the pipeline with a fake codec (ladders, caps, pixel bomb, disguised files, HEIC message, leaky encoder); the queue store contract; the engine with a fake API, PUT and clock covering the happy path, idempotent retries, backoff, offline, attempt budget, manual retry, storage 403 once/twice, expiry, "upload not found", worker rejection, slow processing, every final API status, 401 and sign-in, **a different user signed in**, three scopes in one store, concurrency limit, two tabs with locks, reload resume, dispose, all the cancellation paths (queued, mid-PUT, during `init`, late status result, cancel after the file became evidence, cancel with the server unreachable), duplicates, caps, image errors, serialised preparation, pruning and storage errors. `ApiRequestError` and the browser event wiring have their own tests. Mutation checks (unbounded re-init, no session gate, offline spending attempts, new submission id per attempt, cancel resurrection, no "upload not found" handling) each make a test fail.
* **Playwright (CI, `e2e/evidence-queue-browser.spec.ts`)**, real Chromium on the production build under the strict nginx CSP: the queue store contract on **real IndexedDB**, photos surviving a reload byte for byte, another browser profile seeing nothing, orientation applied, EXIF/GPS removed, a 48 MP photo downsized, PNG/WebP flattened to JPEG, GIF/PDF/SVG/corrupt files refused, undecodable HEIC producing the clear message.
* **Opt-in full stack (`tests-db/evidence-browser-engine.test.ts`, needs a disposable S3-compatible server and Chromium):** real browser engine -> real routes (tenant guard enforcing) -> real presigned PUT -> real finalisation. Nine scenarios, all passing on two consecutive runs: photo to AVAILABLE evidence with the stored object free of EXIF and nothing sensitive in IndexedDB; photos queued while the connection is down surviving a reload and uploading exactly once; a mid-upload connection drop resuming with one record and never a partial object; cancel mid-upload; six photos with at most two in flight; duplicate protection; revoked assignment / unassigned technician / closed job ending as final rejections with no server records; per-account isolation in one browser and sign-out wipe; the HEIC message.

## Remaining for C5c and later

* C5c: the Photos tab (capture/gallery inputs, previews, progress, retry, remove, offline banner, "unsent photos will be lost" confirmation on sign-out and workspace switch, privacy notice) on top of `createUploader`; request persistent storage (`navigator.storage.persist()`).
* C5e: real Android and iOS device pass. In particular **iOS Safari may evict IndexedDB for sites that are not installed to the home screen after about seven days without use**, and Android Chrome can evict under storage pressure unless persistence is granted; the app must treat the queue as best effort and say so. Also optional Background Sync (deferred by decision), malware-scan hook, and the C5.0 re-run on the approved Railway and R2 staging buckets.
