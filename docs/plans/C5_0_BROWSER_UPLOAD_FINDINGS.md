# C5.0: browser upload compatibility findings (local S3-compatible server + real Chromium)

Status: **measured locally, not on Railway or R2.** No staging or production infrastructure was provisioned; nothing was deployed. The harness is `scripts/c50-browser-upload-spike.ts` and the raw report is `evidence/C5_0_browser_upload_spike_report.json`.

## What was run

* **Server:** SeaweedFS 4.48 S3 gateway on loopback (disposable bucket, bucket CORS configured for exactly one page origin). **This is not Railway Buckets or Cloudflare R2.** Their behaviour has to be re-measured with the same script on the approved staging buckets (below).
* **Browser:** headless Chromium (Playwright build 1194) on a page served from a different origin (`http://127.0.0.1:5199`), using real `XMLHttpRequest` PUTs of a real JPEG `Blob`.
* **Signing:** URLs come from the production presigner (`createS3EvidenceStore(...).presignPut/presignGet`), with the production header policy (`content-type` and `content-length` signed).
* **Observation point:** a logging reverse proxy between the browser and the server records the exact preflight and PUT requests (the proxy preserves the `Host` header so SigV4 still verifies). It can also kill a connection mid-body.

18 checks, **18 pass** (one assertion was corrected during the run, see "What the harness taught us").

## Findings

| # | Question | Result |
|---|---|---|
| 1 | CORS preflight | A cross-origin PUT with `Content-Type: image/jpeg` triggers an `OPTIONS` preflight. The bucket must allow **PUT**, the request header **`content-type`**, and the page origin. The browser asked for `content-type` only (not `content-length`). `Access-Control-Max-Age` is honoured (preflight cached). |
| 2 | Presigned PUT from a real browser | Works. Upload progress events fire (`xhr.upload.onprogress`); the final `ETag` is readable only if the bucket exposes it (we do not need it). |
| 3 | Signing compatibility | The signed headers are `content-length;content-type;host`. **`Content-Length` is a forbidden request header for scripts** (Chromium logs `Refused to set unsafe header` and ignores it) but the browser sends the real body length, which equals the signed length, so the signature verifies. **`Content-Type` must match exactly.** Setting the header explicitly works; relying on `Blob.type` alone also works (`image/jpeg` is sent verbatim, no charset added); a Blob with **no** type and no header is refused. |
| 4 | Forged type or size | `text/html` or `image/png` instead of the signed type: 403, nothing stored. A body one byte larger or smaller than the signed length: 403, nothing stored. So the declared size and type really are enforced by the storage service. |
| 5 | Expired and modified signatures | A signature past its expiry: 403 (`AccessDenied`). Another key, an extended `X-Amz-Expires`, or a stripped signature: 403/400, nothing stored. |
| 6 | Unsigned extra header | A script adding `x-amz-acl: public-read` is **blocked by the browser itself** (the CORS allow-list does not list it) and the object is never created or public. The allow-list is therefore a real second control: keep `AllowedHeaders` to `content-type` (and optionally `content-length`). |
| 7 | Cancellation | `xhr.abort()` mid-upload (throttled to about 150 kB/s) fires `onabort`; **no object is created**. The same signed URL can be retried afterwards and completes. |
| 8 | Interrupted connection | **Chromium transparently retries an idempotent PUT once** when the connection drops: with one dropped connection the page saw `200` after two requests on the wire. With two consecutive drops the page gets a network error (`status 0`) and nothing is stored; a manual retry of the same URL then succeeds. No partial object was ever visible. |
| 9 | Offline | Going offline makes the XHR fail immediately as a network error (`status 0`); back online the same URL succeeds. Re-writing the same key with the same bytes (via the same URL or a re-issued URL) is idempotent: one object, same size. |
| 10 | Public access / cross-workspace | Anonymous GET, HEAD, list and PUT: 403. A PUT URL used with GET: 403. A PUT or GET signature re-pointed at another workspace prefix (`/ws/wsB/...`): 403. |
| 11 | Signed GET | Served with the forced `Content-Type: image/jpeg`, `Content-Disposition: inline` and `Cache-Control: private, no-store`; readable cross-origin; works as an `<img>` source; `referrerPolicy = no-referrer` sends **no Referer** to the storage host. `Content-Disposition` is not CORS-safelisted, so script cannot read it (not needed). |
| 12 | Wrong page origin | A page on an origin that is not on the allow-list is blocked by CORS (`status 0`), nothing stored. Use exact origins, never `*`. |

## Design consequences (applied in C5b)

1. **Process first, then ask for the URL.** The `init` call declares `sizeBytes` and `contentType`, and the signature binds both. The exact bytes that were measured must be what is uploaded: the processed JPEG is persisted in IndexedDB *before* `init` and is never re-encoded on a retry. A size or type difference is a hard 403.
2. **Send `Content-Type` explicitly and give the `Blob` the same type.** Never try to set `Content-Length`.
3. **A 403 from storage is ambiguous** (expired signature, wrong size, wrong type all look alike). Policy: on a 403, call `init` again **once** with the same `submissionId` (the server re-signs a still-PENDING upload); if the second PUT also gets 403, stop with a permanent "upload rejected" state. Network errors (`status 0`), 5xx and timeouts are retried with backoff against the same URL while it is fresh and against a fresh `init` once it is close to expiry.
4. **The browser may repeat a PUT on its own.** This is safe (same key, same bytes, idempotent). The engine must not treat a late success after a reported error as a problem: completion is driven by `complete` + status polling, not by counting PUT attempts.
5. **Cancel is safe:** an aborted PUT leaves nothing behind; the server-side cancel (C5a `DELETE`) is still called so the PENDING record does not linger.
6. **Required bucket CORS (exact origins only).** For the staging buckets and later production:
   ```json
   [{ "AllowedOrigins": ["https://<app origin>"], "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type"], "ExposeHeaders": [], "MaxAgeSeconds": 600 }]
   ```
   (R2 and Railway express the same fields in their own dashboards or APIs. `GET`/`HEAD` are needed only if the app fetches signed GET URLs with script rather than `<img>`; `<img>` needs no CORS at all.)
7. **CSP:** `connect-src 'self' https:` already permits the PUT to the storage host; `img-src 'self' data: https:` permits signed-GET images; local previews use `data:` URLs. **No CSP change is needed.** (Plain `http:` storage, as in this local test, would need one, but production storage is always `https`.)

## Confirmed again by the engine (C5b)

The C5b upload engine (`docs/plans/C5B_UPLOAD_ENGINE.md`) runs the same flows through the real API and database: in real Chromium against the same local server, with the real presigner, the signed PUT with only `Content-Type` set, a connection dropped mid-upload (the interrupted upload left no partial object; the retry produced one record), cancel mid-upload, and photos queued across a reload. `tests-db/evidence-browser-engine.test.ts` passes 9/9.

## What the harness taught us

* Content-Disposition looked missing from a script's point of view; it was present on the wire and simply not exposed by CORS (now asserted on the wire).
* A stripped signature returns 400 rather than 403; both mean "refused".
* The first version of the drop test showed `200` instead of an error: Chromium had silently retried the PUT. The harness now tests the single-drop and double-drop cases separately.

## Not covered here (explicit limits)

* **Railway Buckets and Cloudflare R2** behaviour (CORS configuration surface, how strictly they enforce signed `content-length`/`content-type`, error codes, preflight caching). Re-run on the approved staging buckets: `ACAOS_SPIKE_ENDPOINT=... ACAOS_SPIKE_BUCKET=... ACAOS_SPIKE_KEY_ID=... ACAOS_SPIKE_SECRET=... ACAOS_SPIKE_ALLOW_REMOTE=1 npx tsx scripts/c50-browser-upload-spike.ts` (the bucket CORS must allow `http://127.0.0.1:5199` for the run; the script only writes under `spike/`).
* **Real Android Chrome / installed PWA / WebView** (Chromium on Linux is not a phone): covered by the C5e real-device pass.
* **Network conditions beyond a throttled link and hard drops** (captive portals, proxies that rewrite headers) and **very large photos on low-memory devices**.
* **iOS Safari**: not tested.

## Staging request (needs your approval, nothing provisioned)

Two throwaway, empty buckets (one Railway, one R2), each with a single scoped read/write token, CORS as in item 6 for `http://127.0.0.1:5199`, deleted after the run. Expected cost: negligible (a few MB of test objects). Credentials would be supplied by you as one-time environment variables, never committed.
