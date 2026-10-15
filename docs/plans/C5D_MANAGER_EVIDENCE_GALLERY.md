# C5d — Manager evidence gallery

Status: review-only. Read-only gallery of technician photos for managers, on the existing delivery Job /
closeout screen. Reuses the C5a read endpoints and the C2/C3 storage; **no new photo system, no schema
change, no new storage code, no infrastructure**. Production evidence uploads, backups, automatic deletion
and destructive operations stay disabled; with uploads off the gallery is not offered at all.

## Where it lives (Job versus OpsJobSite)

Photos belong to a delivery **Job** (`EvidenceFile.jobId` → `Job`), and one `OpsJobSite` can have several
Jobs. The gallery therefore sits on each Job card in **Delivery** (`OpsDelivery`, the screen that already
holds the closeout and reopen actions), above those actions so photos can be reviewed before closing a job.
It is labelled `<job code> · <site name>` and each Job has its own gallery; Jobs on one site are never merged.
Closed Jobs keep their gallery (managers retain historical access; technicians do not).

## What was added

| Piece | Detail |
|---|---|
| `GET /api/delivery/jobs` | Adds `evidencePhotos: boolean`, the same server-capability-only flag `/assigned` already exposes as `photos`. Manager-only route, so nothing new is revealed to anyone else. The UI offers the gallery only when it is `true`. |
| `lib/evidence/galleryApi.ts` | List and signed-content calls to the C5a endpoints; `SignedUrlCache` (in memory only: reuse a link only while >10 s remain, share one in-flight request, never repopulated by a late answer after `clear()`); status → message mapping. |
| `components/photos/JobPhotoGallery.tsx` | Collapsed "Photos" button (nothing is requested until opened); 24 per page with "Load more photos" (keyset cursor from the server); thumbnails requested only as tiles scroll into view (the content endpoint is limited to 120/min per user); viewer with uploader, time, size, previous/next, arrow keys, Escape. |
| Wiring | `OpsDelivery` renders the gallery per Job when `evidencePhotos` is true. |

## Behaviour that matters

* **Thumbnails**: grid uses the 320 px thumbnail; if a file has none (`hasThumb: false`) the full image stands in. Full-size is requested only in the viewer.
* **Signed links** are 60 s bearer credentials: kept in memory, never shown as text, never logged, `referrerPolicy="no-referrer"`. An `<img>` that fails to load (expired or revoked link) is retried **once** with a freshly signed link, then shows "Photo unavailable" with a Retry button (no retry loop).
* **Unavailable evidence** (`409` not AVAILABLE, `404` missing/unverified): that tile or the viewer says so; the rest of the gallery is unaffected.
* **Revoked access** (`401/403` from the list, a link, or "load more"): the gallery immediately discards every photo and link it holds, shows "You no longer have access to this job's photos", and offers no retry. Roles are resolved per request on the server (cached ≤ 5 s; membership routes invalidate it explicitly), so a removed manager is refused on the next request.
* **Workspace / Job isolation**: every request carries the gallery's own `workspaceId` and `jobId`; changing either resets the component and abandons in-flight answers; the server returns 404 for a foreign file, Job or workspace and 403 for non-members.
* **Read-only**: no upload, delete, download link or file input. Deletion remains C4 governance.
* **CSP**: images are `https:` signed links (`img-src 'self' data: https:`), no `blob:`; the browser spec asserts no violations.

## Tests

* Component (Vitest): 34 gallery tests (loading, pagination, per-tile visibility loading, error/503/429, one-shot expired-link refresh, cache expiry and late-answer behaviour, viewer navigation/keyboard, read-only, revoked access on list/link/load-more, workspace switch incl. slow stale answers, two Jobs on one site) plus 2 `OpsDelivery` tests (gallery absent when the server flag is off/missing, present per Job and calls the Job id, not the site id).
* DB tier (`tests-db/evidence-manager-gallery.test.ts`, tenant guard enforcing, real routes and worker finalisation): capability flag on/off and manager-only; per-Job galleries; cross-workspace isolation by every id combination; demoted/removed manager loses list and content; links ≤ 60 s, dead after expiry and a fresh one works; rejected/deleting/deleted/unverified evidence never listed or signed, missing thumbnail falls back; pagination.
* Browser (`e2e/manager-photo-gallery.spec.ts`, production build, strict CSP, phone and desktop): real JPEGs decode from signed https links, viewer, expired-link refresh, revoked access, gallery hidden when evidence is off, no horizontal scroll.

## Known limits / for review

* Tiles for a Job with many photos still sign one link per visible thumbnail (bounded by the 120/min limit; a 429 shows a per-tile Retry). A batch "sign many thumbnails" endpoint would be a server change, deferred.
* Chromium only; no real-device pass (C5e). No bulk export, annotations or customer sharing (out of scope, PR D).
* A membership change made by a path that does not invalidate the role cache is honoured within 5 s (existing behaviour, not changed here).
* The gallery shows photos only; it does not link them to `JobTechnicianEvidence` notes (`evidenceId` is returned but not rendered).
