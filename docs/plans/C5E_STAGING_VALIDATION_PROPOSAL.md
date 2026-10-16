# C5e — staging validation proposal (Railway Buckets and Cloudflare R2)

Status: **proposal only. Nothing has been provisioned, no credential has been requested or used, and nothing has been deployed.** Each step below needs your explicit approval before it is done. Production uploads, backups, automatic deletion and destructive operations stay disabled throughout.

## Purpose

Everything measured so far ran against a local SeaweedFS server. The unknowns that only the real providers can answer:

1. Does each provider's CORS implementation accept the browser's preflight for a presigned PUT with `Content-Type` (C5.0 findings, item 6)?
2. Does each provider **enforce** the signed `content-type` and `content-length` (forged type or size must be refused), and honour signed-GET response overrides (`response-content-type`, `inline`, `private, no-store`)?
3. Are expired and tampered signatures refused, and are cross-prefix signatures refused?
4. Conditional writes (`If-None-Match`/`If-Match`) for the restore tool (C3).
5. Latency, error codes and timeouts as seen from a phone browser.

## Scope and isolation

| Item | Proposal |
|---|---|
| Environment | One **staging** environment only, separate from production in every dimension. No production project, service, variable, domain or database is touched. |
| Buckets | Two throwaway, **empty** buckets: one Railway Bucket (primary store candidate), one Cloudflare R2 bucket (primary or backup candidate). Names carry `staging` and a date. One bucket per provider; no shared prefix with anything else. |
| Tokens | One scoped read/write token per bucket (bucket-scoped, **no delete on the backup/R2 token** if the provider allows it; the app never deletes). Separate from every production credential. Expiry set to 7 days. |
| Application | A staging API + worker deployment, or (cheaper and safer) **my local stack pointed at the staging buckets** with `ACAOS_SPIKE_ALLOW_REMOTE=1` for the C5.0 script and `ACAOS_S3_IT=1` for the S3 integration tests. Recommendation: start local-against-staging-buckets; deploy a staging app only if you want the phone tests to go through a real HTTPS origin. |
| Data | Synthetic photos only (generated test images). No customer data, no real workspaces. |
| Flags | `EVIDENCE_UPLOADS_ENABLED=true` only in the staging process (and the local run), never in a committed file or in production. `EVIDENCE_BACKUP_ENABLED` only on the staging worker if the restore drill is approved. |

## CORS (exact origins, no wildcard)

The buckets need exactly the staging page origin (and `http://127.0.0.1:5199` for the C5.0 script run, removed afterwards):

```json
[{ "AllowedOrigins": ["https://<staging app origin>"], "AllowedMethods": ["PUT", "GET", "HEAD"],
   "AllowedHeaders": ["content-type"], "ExposeHeaders": [], "MaxAgeSeconds": 600 }]
```

Each provider expresses these fields in its own dashboard/API. `AllowedHeaders` stays at `content-type` only (a browser-added `x-amz-acl` must stay blocked; C5.0 item 6).

## Credentials required from you (supplied as one-time environment variables, never committed, never pasted into tickets)

* Railway Bucket: endpoint, bucket name, access key id, secret access key (scoped to that bucket).
* Cloudflare R2: account endpoint (`https://<account>.r2.cloudflarestorage.com`), bucket name, access key id, secret access key (object read/write on that bucket only).
* If a staging app is deployed: the staging project/service access I should use (a staging-only Railway project), and the staging origin.

I will not use the Railway or any other management connector on production, and I will not create, change or delete anything in a project you have not named.

## Test plan (about two hours of work, mostly automated)

1. **C5.0 browser script** (`scripts/c50-browser-upload-spike.ts`, 18 checks) against each bucket from real Chromium: preflight, signed PUT, forged type/size, expired/modified signatures, cancel/interrupt/offline, cross-prefix, anonymous access, signed GET headers, wrong origin.
2. **S3 integration tests** (`ACAOS_S3_IT=1`: `evidence-s3-integration`, `evidence-browser-engine`): includes the conditional-write test the restore tool depends on. A provider that ignores `If-None-Match`/`If-Match` fails restore safety and is flagged.
3. **Full workflow** (`e2e/evidence-workflow.spec.ts`) with the API/worker pointed at the staging bucket (https endpoint, so no CSP exception is needed).
4. **Phone run** from [ANDROID_PHOTO_DEVICE_TEST.md](../runbooks/ANDROID_PHOTO_DEVICE_TEST.md) against the staging app if one is deployed.
5. Record results in `docs/plans/C5E_STAGING_RESULTS.md` (counts, codes, latencies; no URLs or keys).

## Expected cost

Test volume is a few tens of megabytes and a few hundred requests. At that volume I expect the storage and request charges on both providers to be **negligible (cents, or inside free allowances)**, and egress to be negligible. I have not looked up current price lists for this proposal; I will confirm both providers' current pricing and free tiers and report the figures with the request, before anything is created. A deployed staging API/worker/Postgres/Redis, if you choose that option, adds ordinary small-instance hourly charges for the hours it runs (to be quoted at the time); the local-against-staging-buckets option adds none.

## Rollback and cleanup

* All created resources are listed in the results file the moment they are created (name, provider, creation time).
* On completion (or abort): delete every object, delete both buckets, revoke both tokens, remove the staging origin from any CORS rule, unset the staging variables, and tear down any staging service. I will list what I removed and confirm each is gone.
* Abort conditions: any production resource appearing in the target list, any credential that is not the scoped staging one, any non-synthetic data, unexpected cost above the quoted ceiling.
* Because nothing in production changes, there is nothing to roll back in production; the feature flags are not set there.

## Decisions I need from you

1. Approve (or not) creating the two staging buckets and tokens, and who creates them (you, or me through the connector in a project you name).
2. Local-against-staging-buckets only, or also a deployed staging app for phone testing.
3. Which provider is the intended primary store (affects what the restore/backup drill covers).
4. Cost ceiling for the run.
