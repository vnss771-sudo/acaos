# Android real-device test: technician photo evidence

Status: **checklist only; not yet run.** Run it against a **staging** deployment with disposable buckets, never production. The pass/fail record (section 4) is kept in the repo (`docs/runbooks/records/`) and is one of the release gates.

## 0. Setup

* Two phones: a **low-end** (2 to 3 GB RAM, Android 10 or 11 era) and a **recent** one. Chrome current stable on both. Repeat the key flows once in an **installed PWA / WebView** context if the app is distributed that way.
* A staging workspace with: one manager (owner), two technicians (A, B) linked to crew records, one site with **two Jobs** (J1 assigned to A and B, J2 assigned to nobody), `EVIDENCE_UPLOADS_ENABLED=true` on the staging API and worker only.
* A desktop browser logged in as the manager on Delivery, with J1's Photos gallery available.
* Test photos on each phone: normal 12 MP; a **48 to 108 MP** shot; a portrait (rotated) shot; a screenshot (PNG); a photo with location tagging on; a HEIC/HEIF file if the phone can produce one.
* Record per run: build commit, phone model/OS/Chrome version, network type, tester, UTC time.
* Never paste signed URLs, tokens or screenshots showing them into tickets.

## 1. Checks (mark Pass / Fail / N/A, with a note and a screenshot or screen recording that does not show a signed URL)

| # | Area | Steps | Expected |
|---|---|---|---|
| 1 | Camera capture | A: My jobs > J1 > Photos > **Take photo**; take a photo. | Camera opens (rear). Photo appears with preview, then "Uploading" then "Uploaded". Manager gallery shows it with "Uploaded by A" within a minute (use Refresh photos). |
| 2 | Gallery selection | **Choose from gallery**, pick 3 photos at once. | All three listed; each uploads; no duplicates; manager sees exactly 3. |
| 3 | Metadata | Take a photo with location tagging on. Open the manager's full-size viewer; download is not offered; check the stored object with a metadata tool in staging. | No EXIF/GPS in the stored image; orientation correct (portrait stays portrait). |
| 4 | Mobile data | Wi-Fi off, 4G/5G on; add 3 photos. | Uploads complete; no stalls beyond normal. |
| 5 | Airplane mode | Add 2 photos, enable airplane mode **before** adding the second. Observe the offline banner and "saved on this phone" count. Disable airplane mode. | Both upload on their own; exactly 2 records; no duplicates. |
| 6 | Airplane mode, app restart | Airplane on, add a photo, **swipe the app away**, reopen (still offline), then go online and reopen. | Nothing lost. Photo uploads without opening the Photos tab. (Known: offline, the job list cannot load, finding F1.) |
| 7 | Weak connection | Use the OS or a router to throttle to about 100 to 300 kbps (or walk to a poor-signal area); add a 12 MP photo. | Progress advances; retries are quiet; ends "Uploaded" or a clear stopped/retry state; no duplicate. |
| 8 | Drop mid-upload | Start an upload of a large photo, toggle airplane mode for 10 seconds, restore. | Resumes; one record. |
| 9 | Tab termination | Start uploads, then (a) swipe Chrome away, (b) force-stop Chrome, (c) let the phone sleep 10 minutes with the tab in the background. Reopen. | Queue intact; uploads continue/resume; nothing duplicated; nothing silently lost. Record anything lost. |
| 10 | 48 MP / 108 MP photo | Add the large photo on the **low-end** phone. | Processed within a reasonable time (note seconds), uploaded at a bounded size; no tab crash. If it fails, the message is clear and the photo is not half-saved. Record peak behaviour (UI freeze, reload). |
| 11 | Rotation | Rotate the phone during capture and during upload; add a portrait photo. | Layout stays usable; no lost state; photo upright. |
| 12 | Battery saver | Enable battery saver / data saver; add photos and background the app for 2 minutes. | Note whether uploads pause in the background; on return they resume; no loss. |
| 13 | Persistent storage | Photos tab with unsent photos: read the note under the count. Check Chrome > Site settings > Storage. | Wording says photos can still be lost; it never claims safety. Note whether persistence was granted. |
| 14 | Full storage | Fill the phone storage to < 100 MB free; add a photo. | Clear failure ("not enough space") rather than silent loss. |
| 15 | Account change | A queues a photo offline; sign out (confirm the warning); B signs in. Then repeat without signing out (clear cookies/expire session). | Sign-out warns and deletes only A's photos. Without sign-out, B sees only a count and no delete action; A's photo is intact and uploads when A returns. |
| 16 | Revocation | A queues a photo offline; the manager removes A's assignment; A goes online. | Photo refused with a clear message; no record in the manager gallery. |
| 17 | Accessibility | Turn on TalkBack. Walk the Photos tab: buttons, status text, Retry/Cancel/Remove, dialogs. Increase font size to 200 %. | Controls are labelled; status changes are announced; targets >= 48 px; layout does not overflow horizontally. |
| 18 | Manager on a phone | Manager opens Delivery on the phone; gallery, viewer, Refresh. | Usable; thumbnails load progressively; no horizontal scroll. |
| 19 | Large job | A job with 40+ photos: open the gallery, Load more twice. | Pages of 24; scrolling stays smooth; a rate-limit message with per-tile Retry if hit. |
| 20 | HEIC | Add a HEIC file (if available). | Either converted to JPEG, or the clear "could not convert ... Most Compatible" message; never a silent failure. |

## 2. Stop conditions

Stop and report immediately if: a photo is lost without any message; a photo appears under the wrong account or Job; a signed URL is visible in the UI or a screenshot; GPS metadata is found in a stored object; a duplicate evidence record appears; the tab crashes repeatedly on the low-end phone.

## 3. After the run

Delete the staging test data (the staging bucket is disposable), revoke the staging tokens, and attach the record. A run with any Fail on rows 1 to 3, 5, 9, 15 or 16 blocks release.

## 4. Record template

`docs/runbooks/records/YYYY-MM-DD-android-photo-test.md`: build commit; devices; per row Pass/Fail/N/A with notes; defects raised; sign-off name and date.
