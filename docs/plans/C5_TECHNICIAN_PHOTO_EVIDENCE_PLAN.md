# C5: technician photo evidence (implementation plan)

Status: **plan for approval. No code has been written.** Production evidence uploads, destructive deletion and automatic retention deletion stay **disabled**; nothing here provisions infrastructure or deploys. The real Railway/R2 restore drill, independent PostgreSQL recovery verification, malware scanning and legal review remain release gates (section 9).

## 1. Goal and ground rules

Finish the customer-facing technician workflow: a technician on an Android phone, on an unreliable network, photographs the work (or picks photos) against the correct assigned job; the photo is previewed, uploaded with progress and retry, never duplicated, stripped of EXIF/GPS, and stored privately; a manager can then see it. **Reuse the evidence system that exists (C1 to C4). Do not build a second one.**

## 2. What already exists (reuse)

| Need | Existing code | Notes |
|---|---|---|
| Upload intent, signed PUT, completion, status | `apps/api/src/routes/ops/evidenceFiles.ts`: `POST /api/ops/technician/:jobId/files/init`, `POST …/files/:fileId/complete`, `GET …/files/:fileId` | Idempotent per `(workspace, crew member, submissionId)`; assignment, active job and crew checked under the Job row lock; limits: 10 MiB, 100 files/job, 10 unfinished per technician, 50 GiB/workspace; re-`init` of a PENDING file re-signs the URL; presign TTL 300 s |
| Validation, EXIF/GPS strip, re-encode | `apps/worker/src/processors/evidenceFinalize.ts`, `packages/backend-core/src/lib/evidenceImage.ts` | Sniffs real bytes (JPEG/PNG/WebP), pixel limit, `sharp` re-encode to JPEG; re-checks eligibility before and after; verified in the Alpine worker image (C4 CI smoke) |
| Durable backup and restore | C3: `evidenceBackup.ts`, `evidenceRestore.ts` | Photos are protected only once their backup is `VERIFIED` |
| Retention, holds, deletion | C4 | Governance is owner-only and independent of capture |
| Feature flags, fail-closed config | `evidenceStorageConfig.ts` | Uploads off unless `EVIDENCE_UPLOADS_ENABLED=true` and valid config (503 otherwise) |
| Manager list of notes/checklists | `GET /api/ops/technician/:jobId/evidence` (`ops:manage`, keyset pagination) | Returns notes/checklists only; **no file information** |
| Mobile technician UI | `apps/web/src/views/ops/OpsTechnician.tsx` (My jobs; Note/Checklist/History tabs), `newSubmissionId()` (UUID with Android WebView fallback), 48 px touch targets, per-draft idempotency pattern | Photos are explicitly out of scope there today |
| Typed API access | `makeRouteApi`, `RouteContracts` in `packages/shared`; `check:frontend-mutations` | New API routes need contracts |

## 3. What is missing (gaps)

**Client (the web app has no photo, offline or service-worker code at all):**
1. Camera/gallery capture, preview, client-side downscale and re-encode.
2. An upload engine: direct PUT to the signed URL with progress, retry with backoff, abort, queue.
3. A **persistent** queue (the browser must survive reloads, app switches and dead zones) and duplicate protection.
4. Online/offline handling and a visible "queued / uploading / processing / done / failed" state per photo.

**API:**
5. **No way to read a photo.** There is no list-files endpoint and no download path: `GET …/files/:fileId` returns status only. Needs a short-lived **presigned GET** (technician own files; managers all in the workspace) with auditing.
6. No thumbnails (a gallery of full-size images is too heavy on mobile).
7. No capability signal for the UI: the app cannot tell whether uploads are enabled without trying (503). Add a light flag to the assigned-jobs response.
8. No way to discard a PENDING upload the technician no longer wants (the sweeper reaps it after 24 h).

**Manager surface:** `OpsJobs` manages job *sites*, not Job records with evidence; there is no manager evidence UI at all. A site can have several Jobs, so the manager entry point needs a design decision (section 8).

**Worker:** HEIC/HEIF is rejected (`unsupported_type`); captions have nowhere to live.

## 4. Proposed design

### 4.1 Client image pipeline
- Capture via `<input type="file" accept="image/*" capture="environment">` (camera) and a second input without `capture` and with `multiple` (gallery). No `getUserMedia` (permissions, secure-context and WebView pitfalls) in v1.
- Process one photo at a time: decode with `createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth })` where supported (avoids decoding a 48 MP bitmap on a low-end Android), else `<img>` + canvas; resize to a long edge of about 2,560 px, re-encode JPEG at about 0.85. This (a) normalises orientation, (b) strips EXIF/GPS client-side as defence in depth (the server remains authoritative), (c) typically yields 0.5 to 2.5 MB, which matters on weak networks and sits well under the 10 MiB cap.
- HEIC: Safari/iOS usually hands the picker a JPEG; where the browser can decode HEIC the same pipeline converts it. Where it cannot, show a clear "choose a JPEG/PNG" message. **Server-side HEIC conversion is deferred** (decision in section 8).
- Local preview uses `data:` URLs, which the current CSP already allows, so **no CSP change is needed** (`blob:` is not in `img-src`; the plan avoids adding it). `connect-src 'self' https:` already permits the storage PUT.

### 4.2 Upload engine (a plain TypeScript module with its own tests, then hooked into the UI)
- State machine per photo: `queued → preparing → uploading → processing → done | failed (retryable) | rejected (final)`.
- Uses the existing API: `init` (route client with a contract) → **XHR `PUT`** to the signed URL with the exact headers returned (XHR for upload progress; `fetch` has none) → `complete` → poll `GET …/files/:id` until AVAILABLE or REJECTED (back-off, capped). On a retry after a dead zone the engine calls `init` again with the **same `submissionId`**: the server returns the same file and a fresh signed URL while PENDING.
- Retries: exponential back-off with jitter, resumed on the `online` event and on foreground; permanent errors (job closed, assignment revoked, rejected, 413) stop retrying and say why. `navigator.onLine` is only a hint; real failures drive state. At most 2 uploads in flight; respect 429 (10 unfinished uploads per technician).
- **Persistence:** photo blobs and queue state in IndexedDB so a reload or a killed tab loses nothing. Cleared on logout and workspace switch; capped in size; a "stored on this device until sent" notice. (Photos on a shared handset are a privacy risk: see section 5.)
- **Duplicate prevention:** one `submissionId` per photo, generated once when it is added and stored with the blob; server idempotency covers double-taps and retries; a local SHA-256 warns when the same image is added twice. No new server mechanism.

### 4.3 API additions (small, all inside the existing evidence routes and checks)
- `GET /api/ops/technician/:jobId/files?workspaceId=&cursor=&limit=`: technicians see their own files on jobs they are assigned to; managers (`ops:manage`) see all files on the job; keyset pagination; returns id, status, dimensions, timestamps, thumbnail availability, uploader (managers only). **Never returns object keys.**
- `GET /api/ops/technician/:jobId/files/:fileId/content?workspaceId=&variant=full|thumb`: authorises exactly as the status route, requires `AVAILABLE`, returns JSON `{ url, expiresAt }` with a **presigned GET valid for 60 s**, response headers forced (`image/jpeg`, `inline`, `private, no-store`), `Cache-Control: no-store` on the API response, an audit event (`ops.technician.file.viewed`) and a per-user rate limit.
- `DELETE /api/ops/technician/:jobId/files/:fileId` for a technician's **own PENDING** file only (cancel before processing). It never touches AVAILABLE evidence: that stays with C4.
- `GET /assigned` gains `photos: boolean` (from `resolveEvidenceStorage`) so the UI hides the Photos tab when uploads are off.
- Worker: finalisation also writes a ~320 px JPEG thumbnail as another `EvidenceFileCopy` (`location='thumb'`); it needs no schema change (the location regex allows it), is not backed up (rebuildable), and is removed by the C4 deletion runner's leftover loop and by the sweeper.

### 4.4 UI
- Technician (`OpsTechnician`): a **Photos** tab per job: "Take photo" and "From gallery" (min 48 px targets), a queue list with preview, progress bar, status chip, Retry/Remove, an offline banner, a count of what is waiting, and a gallery of the technician's own uploaded photos (thumbnails, tap for full). Accessible labels and `aria-live` status like the existing forms.
- Manager: a photo gallery with lightbox, uploader and time, for a job (entry point per section 8), read-only; no deletion here.
- Captions are not in v1. (Option: create a NOTE evidence entry and link the photo through the existing optional `evidenceId`, which needs no new storage; decision in section 8.)

## 5. Security risks and mitigations

| Risk | Mitigation |
|---|---|
| Presigned GET URLs leaking (history, logs, referrer) | 60 s TTL; never logged; response `no-store`; images loaded with `referrerpolicy="no-referrer"`; URLs fetched on demand, not stored in state beyond display |
| Cross-tenant or cross-technician reads | Same lookup rules as the status route: `(workspaceId, jobId, fileId)` plus role; another technician's file is indistinguishable from missing; no object keys in any response; tests across workspaces, jobs and roles |
| Revoked or off-job technician still reading | Read requires current assignment; decision on read access after the job closes (section 8); managers keep access |
| Stored XSS / active content | Only server re-encoded JPEG is ever served, with a forced content type and `nosniff`; SVG/HTML cannot reach the store |
| Privacy of GPS and metadata | Stripped client-side and (authoritatively) server-side; v1 stores no location. Any future location capture is a separate, consented feature |
| Photos left on a shared device | IndexedDB cleared on logout/workspace switch; size cap; on-screen notice; no thumbnails cached beyond the session |
| Memory exhaustion on low-end Android | One photo at a time, bounded decode via `resizeWidth`, a hard pre-check on file size/dimensions |
| Upload abuse | Existing per-job, per-technician and per-workspace limits; new endpoints rate-limited per user |
| Malware | Server re-encoding removes executable payloads from the image container; a dedicated scanner decision is still an open release gate |
| Storage CORS | Railway documents that browser uploads need CORS configured on the bucket; R2 supports bucket CORS. **Unverified for our buckets**: see C5.0 |
| Timestamps | Capture time from the device is untrusted; server `createdAt`/`finalizedAt` are authoritative |

## 6. Test requirements

- **Unit (client):** image pipeline (orientation, downscale, EXIF removal, size caps) with real small fixtures; the queue/upload state machine with a fake XHR and fake IndexedDB: backoff, abort, resume after reload, dedupe, permanent vs retryable errors, 429, expired URL → re-init.
- **Unit (web UI, Vitest):** Photos tab states (idle, queued, uploading, offline, failed, done), accessibility, queue clearing on logout.
- **DB tier (tenant guard enforcing):** list/content/delete endpoints: owner technician vs another technician vs unassigned vs revoked vs manager vs other-workspace manager; closed-job behaviour; AVAILABLE only; no keys in responses; audit events; rate limits; cancel only for own PENDING; thumbnails produced and cleaned up; `photos` flag follows config.
- **Real S3 integration (opt-in suite, extended):** signed GET with forced headers; thumbnail lifecycle; CORS where the local server supports it.
- **Browser (Playwright):** mobile viewport + touch emulation, `setInputFiles` for camera/gallery, **offline and throttled-network** scenarios (go offline mid-upload, come back, no duplicate, one file results), reload mid-queue, against the disposable S3-compatible server with CORS enabled.
- **Real-device Android pass (required before the technician experience counts as production-ready):** a written script run on at least two physical phones (a low-end and a recent one) in Chrome and an installed-PWA/WebView context: camera and gallery, airplane-mode drop mid-upload, weak network, killing the tab, large 48 MP photos, rotation, battery saver. Pass/fail record kept in the repo.
- **Gates:** lint, typechecks (real and offline-stub build), `check:frontend-mutations`, coverage gates, tenant-guard DB tier, CodeQL, secret scan, the Alpine worker smoke.

## 7. Phases (each a separate review-only PR; nothing enabled in production)

| Phase | Scope | Depends on |
|---|---|---|
| **C5.0 spike** | Verify, on a throwaway staging Railway bucket and R2 bucket: CORS preflight + XHR PUT with the **signed `Content-Length`/`Content-Type`** from a real Android Chrome, signed GET header overrides, and typical photo sizes. Output: a short evidence note. **Needs your approval for staging buckets.** | approval |
| **C5a read side** | List/content/cancel endpoints, `photos` flag, thumbnails in finalise, contracts, audit, DB + integration tests | none (can start now) |
| **C5b upload engine** | Image pipeline, persistent queue, XHR upload, state machine, unit tests; no UI | C5.0 result for CORS assumptions |
| **C5c technician UI** | Photos tab (capture, gallery, preview, progress, retry, offline banner, own-photo gallery), Vitest + Playwright mobile/offline tests | C5a, C5b |
| **C5d manager viewing** | Job photo gallery + lightbox at the chosen entry point; tests | C5a |
| **C5e hardening** | HEIC decision implemented (if chosen), optional Background Sync (Android Chrome only), real-device Android test script and record, malware-scan hook point, runbook, enable-in-staging procedure | C5c, C5d |

C5a is the lowest-risk start and unblocks the UI work; C5b can proceed in parallel once C5.0 confirms the browser upload path.

## 8. Decisions needed from you

1. **Approve C5.0 staging buckets** (one Railway, one R2, throwaway, empty, scoped tokens) for the browser upload spike. Until then C5b assumes CORS works.
2. **HEIC/HEIF:** client-side conversion only (iOS Safari/decoding browsers) with a clear message otherwise, or server-side conversion later (sharp's prebuilt binaries do not ship HEVC decoding; this would need a different library and a security review). Recommendation: client-side only in v1.
3. **Captions:** none in v1 (recommended), or a NOTE linked through `evidenceId`.
4. **Technician read access:** only while assigned to an ACTIVE job (matches upload), or also read-only after closeout/revocation? Recommendation: assigned and job ACTIVE; managers always.
5. **Manager entry point:** per site (`OpsJobs`, which may map to several Jobs), a new "Technician evidence" view listing jobs, or from the job/closeout screen. This needs a small job-listing endpoint.
6. **On-device persistence:** accept IndexedDB queueing of unsent photos (cleared on logout)? Recommendation: yes, with the notice and size cap.
7. **Background Sync (Android Chrome):** include in C5e or leave out (iOS has no equivalent, so it cannot be the only mechanism).
8. **Limits:** keep 10 MiB / 100 per job / 10 unfinished per technician, or change after the C5.0 size measurements.
9. **Malware scanning:** decide the approach (in-worker scanner vs provider feature) before any production enablement.

## 9. Out of scope and release gates (unchanged)

Out of scope here: ProofPack/PDF/customer sharing (PR D), photo deletion by users, location capture, video, annotation, bulk export, any change to retention or the Railway/R2 architecture (C4b is options only).

**Production enablement requires, at minimum:** the real Railway/R2 restore drill passed, independent PostgreSQL recovery verified, a malware-scanning decision implemented, legal review of retention and the ledger, the real-device Android pass, the C4b provider-isolation decision, and your explicit approval. Until then `EVIDENCE_UPLOADS_ENABLED`, `EVIDENCE_BACKUP_ENABLED`, `EVIDENCE_DESTRUCTIVE_ENABLED` and `EVIDENCE_LEDGER_ENABLED` remain unset in production.
