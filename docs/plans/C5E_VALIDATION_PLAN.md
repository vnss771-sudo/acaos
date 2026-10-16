# C5e — validation plan, local results and findings

Status: review-only. **Nothing was provisioned, deployed or enabled.** Everything below ran on loopback in a disposable process tree; evidence uploads were enabled only inside that run (never in a committed file or shared environment). Production evidence uploads, backups, automatic deletion and destructive operations remain disabled.

Parent plans: [C5](C5_TECHNICIAN_PHOTO_EVIDENCE_PLAN.md), [C5.0 findings](C5_0_BROWSER_UPLOAD_FINDINGS.md), [C5b](C5B_UPLOAD_ENGINE.md), [C5c](C5C_TECHNICIAN_PHOTO_UI.md), [C5d](C5D_MANAGER_EVIDENCE_GALLERY.md).

## What was built

| Piece | Purpose |
|---|---|
| `npm run e2e:evidence-local` (`scripts/e2e-evidence-local.sh`) | Starts on loopback: a throwaway SeaweedFS S3 server (Docker) with a bucket and exact-origin CORS, an ephemeral PostgreSQL (migrated), Redis, the **real API**, the **real worker** (BullMQ finalisation), and the **production web build behind the production CSP**; runs the spec; tears everything down. |
| `e2e/evidence-workflow.spec.ts` | The technician-to-manager workflow in real Chromium with nothing mocked (below). Uses its own config, `playwright.evidence.config.ts`; it is not part of the default Playwright run or of CI. |
| `scripts/serve-web-csp.mjs --local-storage-origin` | Local test only: adds one **loopback http** origin to `connect-src`/`img-src` so the page can reach the local S3 server (production storage is https, which the shipped policy already allows). Refuses any non-loopback or https origin; `nginx.conf` is untouched. |
| `scripts/e2e-evidence-s3-setup.ts` | Creates the bucket and CORS on the local server; refuses a non-loopback endpoint. |

## Scenarios (8, all pass locally)

1. **Full workflow**: a technician on a 412 px Android profile adds two photos (one 4000x3000 with EXIF/GPS/Copyright). Server state: exactly two `AVAILABLE` records, primary and thumbnail copies `VERIFIED`, two final and two thumb objects, stored bytes are JPEG with no EXIF, no owner string, long edge <= 2560. A manager on desktop sees both on that Job's card, thumbnails decode, the viewer shows the full image and "Uploaded by Tech 1".
2. **Gallery refresh**: a photo uploaded after the manager opened the gallery appears after closing and reopening it (see finding F2).
3. **Weak signal / offline**: photo routes and storage blocked while the rest of the API answers; the photo survives a reload, uploads once on reconnect; a further reload uploads nothing more (1 record, 1 object).
4. **Airplane mode**: no connectivity at all, app reopened (even the session refresh fails); nothing is lost; once online the app uploads the photo **without anyone opening the Photos tab** (see F1).
5. **Interrupted uploads**: two storage connections dropped and the first `complete` answer lost (server did the work, phone never heard): one record, one object, one thumb.
6. **Shared phone**: technician A queues a photo; B signs in on the same browser profile. B sees only a count and the "can't be opened, uploaded or deleted" note, has no delete control, uploads nothing for A, and uploads their own; when A returns, A's photo uploads under A. Final owners are exactly {A, B}.
7. **Assignment revoked while a photo waits**: refused, the phone says so, no `EvidenceFile`, no objects.
8. **Manager access revoked while the gallery is open**: after the (<= 5 s) role cache, opening the viewer clears every photo and shows the no-access message.

Every scenario also asserts there were no Content-Security-Policy violations.

## Findings

* **F1 (UX gap, no data loss).** After the app is reopened offline, the technician cannot reach the Photos tab: the job list needs `/assigned`, which fails ("Failed to fetch"), and the Photos tab lives inside a job. The queued photos are safe and **do upload on their own** once online (the provider starts the engine for queued photos at app load), but the technician cannot see or manage them while offline. Suggested follow-up (not in this PR): a small app-level "N photos waiting" banner (the foreign-photos notice already sets the pattern) and/or caching the last job list. Needs a product decision.
* **F2 (defect, fixed in this PR).** The manager gallery loaded its list once per page view; photos uploaded afterwards were not shown until a full page reload. It now re-reads the list every time it is opened and has a "Refresh photos" button (unit tests added). Found by the local workflow test.
* **F3 (test-harness note).** Two Jobs on one site correctly get separate galleries; the first card on the Delivery page is the most recently started Job, so a test (or a person) must use the right card. Gallery toggles carry `aria-controls="job-photos-<jobId>"`.
* **F4 (limit, unchanged).** Real signed-GET and PUT behaviour against Railway Buckets and R2 is still unmeasured (see staging proposal). Chromium on Linux only.
* No other defects: no duplicates, no leaked objects in the upload prefix after rejection, no cross-account upload or visibility, no CSP violations, no URLs in the UI text.

## Not covered (explicit)

Real phones and carriers (checklist: [ANDROID_PHOTO_DEVICE_TEST.md](../runbooks/ANDROID_PHOTO_DEVICE_TEST.md)), iOS Safari, HEIC decoding, Railway/R2 ([staging proposal](C5E_STAGING_VALIDATION_PROPOSAL.md)), malware scanning (release gate), backups/restore on real buckets.

## Remaining iOS Safari and HEIC limitations

* **HEIC/HEIF is converted on the phone only.** iOS Safari can decode HEIC through `createImageBitmap`/canvas on recent versions, in which case the photo is re-encoded to JPEG like any other; where the browser cannot decode it the person gets "could not convert that HEIC/HEIF photo ... change the camera format to Most Compatible". There is no server-side HEIC conversion (sharp's prebuilt binaries do not decode HEVC) and none is planned for v1. **Untested on a real iPhone.**
* **iOS Safari storage.** IndexedDB can be evicted (Safari's seven-day rule for sites without use, storage pressure, "Clear History and Website Data"). `navigator.storage.persist()` is a request that iOS may ignore. The UI never promises photos are safe; unsent photos can be lost on iOS in those cases.
* **No Background Sync on iOS** (and not implemented on Android either in v1): uploads continue only while the app is open or resumed (online/focus/visibility/pageshow). A photo taken at a site with no signal uploads next time the app is opened with signal.
* **Camera capture on iOS**: `capture="environment"` behaves differently (a chooser may appear); the gallery input is always available.
* **Memory on low-end phones**: 48 MP photos are decoded and downscaled in the page; the pipeline caps source pixels (120 MP) and file size (60 MB) and fails with a clear message, but out-of-memory behaviour on a low-end phone is exactly what the device checklist measures.
* **Installed PWA/WebView** contexts may have different storage and camera behaviour; test them separately.

## Release gates (unchanged) and open security risks

Open production-blocking security risks are tracked in [EVIDENCE_OPEN_SECURITY_RISKS.md](EVIDENCE_OPEN_SECURITY_RISKS.md); in particular **R-1: the R2 backup writer's token can delete backups, so the backup is not provider-enforced deletion-proof.**


Real Railway/R2 restore drill, independent PostgreSQL recovery, implemented and tested malware-scan fail-closed policy, legal review of retention and the ledger, the C4b provider-isolation decision, the real-device pass (this plan's checklist), and your explicit approval. Until then `EVIDENCE_UPLOADS_ENABLED`, `EVIDENCE_BACKUP_ENABLED`, `EVIDENCE_DESTRUCTIVE_ENABLED` and `EVIDENCE_LEDGER_ENABLED` stay unset in production.

## How to run

```
docker info                       # the Docker daemon must be running
ACAOS_CHROMIUM=/path/to/chrome npm run e2e:evidence-local     # optional ACAOS_CHROMIUM if Playwright's own browser is not installed
```

Ports used (override with `E2E_PGPORT`, `E2E_REDISPORT`, `E2E_S3PORT`): 55433, 56380, 8333, plus 4000 (API), 4173 (web), 9099 (worker health). On failure the script keeps its logs and prints their location.
