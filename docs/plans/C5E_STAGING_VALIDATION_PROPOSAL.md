# C5e — staging validation plan (Railway private Storage Bucket primary, Cloudflare R2 backup)

Status: **plan only, priced from the providers' own documentation as read on 2026-10-16.** Nothing has been provisioned, no credential has been requested or used, nothing has been deployed. Every step below needs your explicit go-ahead. Production uploads, backups, automatic deletion and destructive operations stay disabled throughout, and no production credential is ever used.

## Decisions recorded (from you)

| Decision | Choice |
|---|---|
| Primary store | Railway private Storage Bucket |
| Independent backup | Cloudflare R2 |
| Spending ceiling for the whole exercise | **A$20** (proposed) |
| First run | **Local** stack pointed at the staging buckets. A deployed staging app is deferred until separately approved. |
| Credentials | Staging only, never production |

## What the providers' documentation says (sources at the end)

| Topic | Railway Storage Bucket | Cloudflare R2 |
|---|---|---|
| Storage price | US$0.015 per GB-month, **rounded up to the next whole GB-month** (a 5.1 GB-month total bills as 6) | US$0.015 per GB-month (Standard); first **10 GB-month free** |
| Requests | **Free and unlimited** (all S3 API operations) | Class A (writes, lists) US$4.50 per million, first **1 million free**; Class B (reads) US$0.36 per million, first **10 million free** |
| Egress | Free (bucket egress). Egress from a *Railway service* to/from a bucket is not free (US$0.05/GB), but nothing runs on Railway in the local-first plan | Free |
| Minimum charge | A paid or trial plan is needed. **Hobby is US$5/month and always billed**, with US$5 of usage included. Free plan: up to 10 GB-month against the US$1 credit, and bucket access is **suspended** when the credit is used up. Trial: up to 50 GB-month on trial credit. **Buckets are not available on the Limited Trial.** | R2 must be enabled ("purchased") on the Cloudflare account before tokens can be made; free tier covers this test |
| Spend cap | Railway **hard usage limit**: when hit, bucket access is suspended (existing data still billed) | None documented; the test stays inside the free tier |
| Regions | `sjc` US West, `iad` US East, `ams` EU West, `sin` Singapore. **Fixed at creation.** No Australian region | Automatic, or location hint (`oc` Oceania, `apac`, etc., best effort); jurisdictions only `eu`, `fedramp`, `us`. No guaranteed Australian residency |
| Credentials | One access key / secret / endpoint per bucket instance per environment (variables `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, `BUCKET`, `REGION`). **No scoped or read-only keys documented.** Buckets are on the public network (not private networking) but private (no public URLs; access only by credential or presigned URL) | API tokens at four permission levels: Admin Read & Write, Admin Read, **Object Read & Write**, Object Read; the object levels can be limited to named buckets, with optional expiry. Temporary credentials can also be derived. **No documented "write but not delete" level** |
| URL style | **Virtual-hosted** (`<bucket>.<endpoint>`); older buckets may need path style. Our config supports both (`EVIDENCE_S3_FORCE_PATH_STYLE`, default off) | Both; presigned URLs only work on the `<account>.r2.cloudflarestorage.com` domain, not custom domains |
| Presigned URLs | Supported, up to 90 days; free egress | Supported (GET, PUT, HEAD, DELETE) |
| CORS | The docs say to configure CORS for browser uploads, but the section's content could not be retrieved; **how and which fields must be confirmed live** | Dashboard JSON, Wrangler or API: `AllowedOrigins`, `AllowedMethods`, `AllowedHeaders`, `ExposeHeaders`, `MaxAgeSeconds`; changes can take up to 30 s. One `*` wildcard max per origin, no paths. **Expired presigned URLs return `403 ExpiredRequest` without CORS headers, so a browser sees a network error (status 0), not a 403** |
| Conditional writes | Not documented (the restore tool needs `If-None-Match`/`If-Match`; **must be tested**) | `PutObject` supports `If-Match`/`If-None-Match`, evaluated atomically (`412` on failure) |
| Not supported | Server-side encryption, object versioning, object locks, **bucket lifecycle configuration**; no automatic backups | Object lifecycle and object locking not supported on PutObject; versioning not part of this plan |
| Deleting | Deleting a bucket is staged and restorable for **52 hours**, then everything is destroyed | Delete objects, then the bucket |

## What changes in our earlier documents (corrections)

1. **The "no-delete R2 token" assumption (C3 runbook, C3 verification notes, PR C plan) cannot be met with R2's documented token levels.** Object Read & Write is the lowest level that writes, and nothing documents write-without-delete. The backup's "never deletes" property is therefore enforced by our code (the C4 delete-boundary check, `EVIDENCE_DELETE_*` never set on the backup service) and by a separate *read-only* token for the restore operator, not by the provider. The plan tests whether the token can in fact delete (one attempted `DeleteObject` on a throwaway object). The residual risk belongs in the C4b provider-isolation decision.
2. **Railway has no scoped credentials**: whoever holds the bucket key can also delete. The same reasoning applies; keep that key off every service that doesn't need it.
3. **R2 expired presigned PUTs look like network errors in a browser.** The upload engine retries network errors against the same URL while it is "fresh" and re-signs near expiry, so it should recover, but this needs to be measured (test 6 below).
4. **Neither provider has lifecycle rules**: orphaned `upload/` objects are cleaned only by our own sweeper. The test checks the sweeper removes them on both.
5. **No Australian region on either.** Singapore (`sin`) is the nearest Railway region; R2 has only a best-effort Oceania hint. Where evidence photos of Australian sites may be stored is a privacy/legal question for the existing legal-review gate (cross-border disclosure), not something this exercise decides.

## Proposed disposable configuration

| Item | Value |
|---|---|
| Railway | A **new, empty, staging-only project** (no production service or variable in it), one bucket named `acaos-staging-evidence-YYYYMMDD`, region `sin`, environment `staging` |
| R2 | One bucket `acaos-staging-backup-YYYYMMDD` with location hint `oc`, default jurisdiction |
| Railway guard rail | Set the project/workspace **hard usage limit** to a low figure (proposed US$8, about A$12) before creating the bucket, so a mistake suspends the bucket instead of billing |
| R2 tokens | (1) Object Read & Write, scoped to the one bucket, expiring in 7 days (backup writer, used by the local worker). (2) Object Read only, same bucket, expiring in 7 days (restore operator). No Admin token is created; the bucket is created by you in the dashboard or by a short-lived Admin token you delete immediately |
| Railway key | The bucket's own credentials (the only kind) |
| Origins in CORS | Only the origin the page is served from. For the local-first plan that is `http://localhost:4173` (plus `http://127.0.0.1:5199` while the C5.0 script runs); no wildcard |
| CORS rule (both buckets, adapted to each UI) | `AllowedOrigins`: exact origins above; `AllowedMethods`: `PUT`, `GET`, `HEAD`; `AllowedHeaders`: `content-type`; `ExposeHeaders`: empty (add `ETag` only if a test needs it); `MaxAgeSeconds`: 600 |
| Data | Synthetic images only |

## Run plan (about two hours, mostly automated; no deployed app)

All on my side, in the existing sandbox, with the buckets above and credentials supplied as environment variables:

1. **Preflight, no writes**: confirm endpoint style, region, list permission, clock skew.
2. **C5.0 browser script** (18 checks) against the Railway bucket, then (as the backup target) against R2: preflight, signed PUT, forged type/size, expired/modified signatures, cancel/interrupt/offline, cross-prefix, anonymous access, signed GET headers, wrong origin.
3. **S3 integration tests** (`ACAOS_S3_IT=1`): includes the conditional-write test the restore tool depends on (expected: R2 pass; Railway to be measured).
4. **Full workflow** (`npm run e2e:evidence-local` variant with the endpoint pointed at the Railway bucket; the page needs no CSP exception because the endpoint is https).
5. **Backup path** (local worker only, `EVIDENCE_BACKUP_ENABLED` set in that process): primary object replicated to R2, read-back checksum verified, restore dry-run, then a restore of a deliberately removed *staging* primary object using the owner-approval path.
6. **Provider-specific checks**: expired presigned PUT as seen by Chromium on R2 (status 0 and engine recovery); an attempted `DeleteObject` with the R2 backup token and with the Railway key (to document, not to rely on); sweeper removal of orphaned `upload/` objects on both providers.
7. Results go in `docs/plans/C5E_STAGING_RESULTS.md` (counts, codes, latencies; no URLs, keys or account ids).

## Estimated cost

Assumptions: test footprint under 100 MB and a few thousand requests; **1 US$ = A$1.55 (an assumption; confirm at the time)**; the exercise runs for under 48 hours.

| Line | Case A: you already have a paid Railway plan | Case B: a new Hobby plan is needed |
|---|---|---|
| Railway bucket storage (rounded up to 1 GB-month, at most; average over days stored is less) | US$0.015, about **A$0.02** | US$0.015, about A$0.02 |
| Railway plan fee | none extra | **US$5 for the month, about A$7.75** (billed in full; cancel afterwards to avoid the second month) |
| Railway requests / egress | free | free |
| R2 storage, operations, egress | **A$0** (inside the 10 GB-month, 1M Class A and 10M Class B free allowances; egress free) | A$0 |
| Cloudflare plan | no charge for R2 within the free tier (R2 must be enabled with a payment method on file) | same |
| **Total expected** | **under A$0.10** | **about A$8** |
| Ceiling you set | A$20 | A$20 |

The Free or Trial Railway plans could avoid the US$5 but have conditions (Free: 10 GB-month and suspended access when the US$1 credit is gone; Trial: one-time US$5 credit, not available on a Limited Trial). I will not guess which applies: it needs a read-only look at the plan on your Railway workspace. The ceiling is generous for both cases; the realistic worst case (Hobby fee plus a forgotten bucket for a month) is still well under A$20.

## Credentials: what I need and how to supply them safely

* **Do not paste keys into this chat.** Set them as environment secrets for this environment (the sandbox documentation describes the settings page) under the names below, so they are available to my commands as variables and never appear in the transcript or in any file.
* Railway: `STG_RAILWAY_S3_ENDPOINT`, `STG_RAILWAY_S3_BUCKET`, `STG_RAILWAY_S3_KEY_ID`, `STG_RAILWAY_S3_SECRET` (and the region value shown on the bucket's Credentials tab).
* R2: `STG_R2_S3_ENDPOINT`, `STG_R2_S3_BUCKET`, `STG_R2_BACKUP_KEY_ID`, `STG_R2_BACKUP_SECRET` (read/write token) and `STG_R2_RESTORE_KEY_ID`, `STG_R2_RESTORE_SECRET` (read-only token).
* Network: the sandbox's outbound policy must allow the two storage hosts; I will check this with the environment-network documentation before the run and tell you the exact hosts to allow.
* I will refuse to run if an endpoint or bucket name does not contain `staging`, and the helper scripts will refuse non-staging names.

## Isolation and rollback

* Nothing in production is read, written or configured; no production variable, service, domain, bucket or database is touched.
* Flags (`EVIDENCE_UPLOADS_ENABLED`, `EVIDENCE_BACKUP_ENABLED`) are set only inside the local process tree for the run.
* **Clean-up order** (done by you or by me, as you prefer, and confirmed one resource at a time): delete all objects in both buckets; delete the R2 bucket; delete both R2 tokens; delete the Railway bucket (it is restorable for 52 hours, then destroyed, so delete the objects first if you want data gone sooner); delete or leave the empty staging project; remove the secrets from the environment; if a Hobby plan was started only for this, downgrade or cancel it.
* **Abort conditions**: anything non-staging in a target list; a credential that isn't the scoped staging one; non-synthetic data; the Railway usage limit being approached; cost above the A$20 ceiling.

## What I need you to confirm before anything is created

1. Which Railway plan the workspace is on (or permission for a read-only look at it), and whether a new Hobby subscription is acceptable (Case B above).
2. That you (not I) will create the Cloudflare tokens and the Railway bucket, **or** that I may create the Railway project/bucket through the Railway connector in a project you name (R2 has no connector here, so its bucket and tokens would be yours either way).
3. The hard usage limit figure to set on Railway (proposed US$8).
4. That the storage hosts may be allowed in the sandbox network policy.

## Sources (read 2026-10-16)

* Railway: Storage Buckets, Storage Buckets Billing, Uploading & Serving Files, Storage Buckets guide, Pricing Plans, CLI `bucket` (regions) at docs.railway.com.
* Cloudflare R2: Pricing, Configure CORS, Authentication (API tokens), Data location, S3 API compatibility (conditional operations), Presigned URLs at developers.cloudflare.com/r2.
