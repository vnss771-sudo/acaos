# C5c — Technician mobile photo interface

Status: review-only. Builds the technician "Photos" tab on the C5b upload engine. No new server
routes, no schema change, no infrastructure. Production evidence uploads, backups, automatic deletion
and destructive operations stay disabled (`/assigned` returns `photos: false` unless the server flag is on, and the tab does not render then).

## What was added

- **App-level `PhotoUploadProvider`** (`components/photos/`). The engine lives above routing, so
  navigating between screens does not stop uploads. It is created only for a signed-in user in a
  workspace, and only once the technician opens a photo-enabled job or the queue already holds photos for that scope.
  Token refresh does not rebuild it (api/user held in refs).
- **Photos tab** (`PhotosTab.tsx`) in the job detail: "Take photo" (`capture="environment"`) and
  "Choose from gallery" (multiple). 48px minimum targets, labelled controls, `aria-live` status,
  wrapping layout verified at 412px and 320px. Per photo: preview, size, state text (waiting, uploading with progress,
  checking, uploaded, stopped, not uploaded), and Retry / Cancel / Remove / Clear.
- **Removal is confirmed** when a photo is still on the phone. If the upload finishes while the
  question is open the dialog says so and nothing is removed.
- **Sign-out** with unsent photos (any workspace of that user) shows a warning; confirming deletes that user's local
  photos then signs out. Staying keeps everything. A *forced* session expiry never wipes photos; they wait for the user to sign in again.
- **Workspace switch** with photos waiting in the current workspace warns but never deletes; photos resume
  when the user returns to that workspace.
- **Another account on the same phone**: the engine refuses to act unless the session user equals the queue
  owner. The new account sees only a count and a note that the photos can't be opened, uploaded or deleted
  from this account. There is deliberately **no delete action** for another account's photos in v1: they are
  finished or removed when their owner signs in again (or deleted at that owner's sign-out). A future
  authorised cleanup process (for example a managed-device wipe) would be a separate, reviewed change.
- **If local cleanup fails at sign-out**, sign-out is still possible but is never reported as having deleted
  photos. A second dialog ("Photos may still be on this phone") says the photos may remain, and offers
  "Stay signed in" (uploads resume) or "Sign out anyway". The same dialog appears when local storage can't be read at all.
- **Persistent storage** is requested (`navigator.storage.persist`) where supported. Wording never promises
  safety: even when granted, the UI says photos can be lost (cleared browsing data, low space).
- Previews are tiny `data:` JPEGs (the CSP has no `blob:`), generated best effort and dropped if oversized.

## Unchanged

Authorization stays assignment based on the server (init/complete/cancel are rejected for jobs the
technician is not actively assigned to; the UI only reflects that). Client limits are the C5b limits
(30 photos / 120 MB queue, 10 MB per processed JPEG, 2 concurrent, EXIF/GPS stripped, HEIC converted in the browser or refused with a clear message).

## Tests

- Component/provider tests with the real engine over a fake backend (`PhotosTab.test.tsx`, `PhotoUploadProvider.test.tsx`, `OpsTechnicianPhotos.test.tsx`): states, controls, guards, cross-account, navigation, cancellation races, offline recovery.
- `e2e/technician-photos-ui.spec.ts`: production build + strict CSP + Android profile, real IndexedDB/image pipeline, fake API and storage.

## Known limits (for review)

- Only Chromium is tested; real Android/iOS devices and iOS Safari storage eviction are a C5e task.
- A job's *already uploaded* photos are not listed from the server here (manager gallery is C5d); finished items show from the local queue for 24h.
- `failed` photos stay on the phone until retried or removed (no age limit).
- Sentry now sees `ApiRequestError` for failed API calls (from C5b).
