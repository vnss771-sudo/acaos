# F1 — "N photos waiting" banner (proposal for a separate review-only PR)

Status: **proposal.** Not implemented. Scope is the lightweight banner only; no offline job cache.

## Problem (finding F1)

After the app is reopened with no or poor connectivity, the technician cannot reach the Photos tab (it lives inside a job, which needs the job list from the API). Queued photos are safe and upload by themselves once online, but the technician cannot tell they exist or what state they are in.

## Design

A small banner in the app shell (same place and pattern as `ForeignPhotosNotice`), driven only by the local queue summary (`store.summary()`, which returns counts and byte totals, never photo data) and the existing engine state.

| Situation | What is shown | Notes |
|---|---|---|
| Signed in, photos waiting for **this user** (any workspace of theirs) | "**N photos** saved on this phone are waiting to upload." plus a state line: *waiting for a connection* / *uploading* / *N need attention* | Counts only the signed-in user's own unsent photos (the existing `summarize`, which counts unsent states with a blob). Another account's photos are **never** included (they keep the existing separate count-only notice, with no delete action). |
| Same, and the person is in another workspace than the photos' | "N photos in *\<workspace name\>* are waiting; they upload when you switch back." | From the summary rows for that user; workspace name from the already-loaded workspace list. |
| Signed in, a photo needs attention (stopped / not uploaded) | "N photos need attention. Open the job's Photos tab to retry or remove them." | The banner never offers delete. |
| Online and uploading | "Uploading N photos…" | Disappears at zero. |
| **Not signed in** (for example the app reopened fully offline, so the session could not be refreshed) | Generic text on the sign-in screen, **no count and no account hint**: "Photos saved on this phone are waiting to upload. Sign in with the account that took them." Shown only when the local queue is non-empty. | We cannot know whose they are, and must not reveal more. Whether to show even this generic line is a privacy call for you. |
| Nothing waiting | nothing | |

Interaction: one button, "Try uploading now", which asks the engine to resume (it already does so on online/focus/visibility). No navigation to a job is promised while the job list is unavailable; when it is available the banner text can link to My jobs.

Accessibility: `role="status"` with polite announcements, at least 44 px touch target, wraps at 320 px, no new colours outside the existing tokens.

## Constraints kept

* Reads only local counts; no new network calls, no new API route, no schema change.
* No signed URLs, photo bytes, previews, job names or file names in the banner.
* Does not start the engine; it uses what the provider already runs (the provider already activates the engine at app load when the signed-in user has queued photos).
* No change to production flags or the sign-out/switch warnings.

## Tests (planned)

* Unit/component: counts only the signed-in user's unsent photos across their workspaces; excludes other accounts, `done`/`rejected` items, and items without a blob; correct text per state (offline, uploading, needs attention, other workspace); the generic signed-out text has no count and renders only for a non-empty queue; "Try uploading now" resumes the engine once; no banner when empty.
* Privacy regression: with account B signed in, A's queued photos produce no B-banner text and no count in the banner (only the existing foreign notice); no photo data in the DOM.
* Local full-stack (`npm run e2e:evidence-local`): (a) weak-signal reopen, job list failing: the banner shows N and the state, photos still upload exactly once when restored; (b) airplane-mode reopen: the signed-out generic line (if approved) and, after sign-in, the count; (c) shared phone: B never sees A's count in the banner.

## Open decisions for you

1. Show the generic signed-out line on the sign-in screen (reveals only that the phone holds unsent photos), or show nothing until sign-in?
2. Count across all of the user's workspaces (proposed) or only the active one?
3. Include the "Try uploading now" button, or banner text only?

## Branch note

Both this and the staging plan live on the single designated working branch. This is built as its own PR once the docs PR containing this proposal is merged (or sooner if you allow a second branch).
