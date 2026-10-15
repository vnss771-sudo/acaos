# C4b: provider-level credential isolation and lawful early erasure: options

Status: **options only. No provider decision has been made and nothing in this document is implemented.** The current Railway + R2 architecture is unchanged. Production destructive operations stay disabled (the `EVIDENCE_PROVIDER_ISOLATION` attestation gate from C4 cannot honestly be given until one of these is built and verified). Long-term option to investigate, per the product owner: **native S3 Object Lock in governance mode**.

## The problem

C4 separates delete-capable credentials in *configuration* and *code*, but a leaked or abused **normal** token (API presign, upload/finalise worker, backup worker) can still delete evidence at the storage provider, because:

- R2 and Railway tokens are scoped per bucket; as far as I could determine, R2's object read/write token level includes delete and there is no create-without-delete token level (token permission levels were **not** re-verified against R2's token documentation for this document).
- Uploads and final objects share one bucket (`ws/<ws>/job/<job>/upload/…` and `…/final/…`), and the upload worker legitimately deletes `upload/` staging objects, so its bucket-wide token can also delete `final/` objects.
- The backup worker's token can delete backups for the same reason.

The goal is: a stolen normal token cannot delete or overwrite final evidence or backups, **enforced by the provider**, while still allowing (a) the 7-year default retention, (b) per-workspace retention settings, (c) legal holds, and (d) a defined path for lawful early erasure.

## Provider facts (checked against provider documentation, 15 Oct 2026)

**Cloudflare R2 bucket locks** (<https://developers.cloudflare.com/r2/buckets/bucket-locks/>):
- A rule has a **key prefix** and one of three conditions: retain for an **age** (seconds since the object's creation), until a fixed **date**, or **indefinitely**. Up to **1,000 rules per bucket**. Where rules overlap, the longest wins.
- A lock **prevents deletion and overwriting** of covered objects, applies to new and existing objects, and takes precedence over lifecycle rules. A bucket cannot be emptied while rules exist.
- Rules are created and **removed** through the dashboard, API or wrangler by anyone with R2 bucket-configuration permission: the lock is not protection against an account administrator.

**R2's S3 API does not implement Object Lock** (<https://developers.cloudflare.com/r2/api/s3/api/>: `PutObjectLockConfiguration`, `GetObjectLockConfiguration` and the object-lock bucket header are listed as unimplemented). So on R2 there are **no per-object retain-until dates, no per-object legal holds and no governance/compliance modes**.

**Railway Storage Buckets** (<https://docs.railway.com/storage-buckets>): object locks and object versioning are **not supported**. Browser uploads need CORS configured on the bucket.

**S3 Object Lock (AWS S3 and S3-compatible services that implement it)**, from the AWS documentation, not re-fetched for this document: requires versioning; per-object **retain-until date** set at write; **governance mode** (the retention can be bypassed or shortened only by principals granted the bypass permission, with an audit trail) or **compliance mode** (nobody, including the root account, can shorten it); independent per-object **legal hold** (on/off, no date); IAM can express "may put and get, may not delete" so credential isolation is a real provider control. Which S3-compatible services other than AWS implement Object Lock, and how faithfully, was **not verified here**.

## Options

| | **A. Today:** code boundary + attestation (current) | **B. Staging split + token isolation, no lock** | **C. R2 bucket locks + staging split** | **D. C + client-side encryption (crypto-shredding)** | **E. Native S3 Object Lock (governance mode)** |
|---|---|---|---|---|---|
| What it is | Distinct tokens, resolvers that disable a service holding delete creds, static boundary check, ledger | Upload staging in its own bucket; a small separate "publisher" service holds the only evidence-bucket write token | B plus lock rules on the evidence and backup buckets | C, with each object encrypted before upload under a per-workspace (or per-file) key | Evidence (and backups) on a provider with Object Lock; governance mode; legal hold per object |
| Provider stops a normal token deleting evidence | **No** | **No** on R2/Railway (a write token can delete). It only reduces what the staging token reaches | **Yes**, for every token, until the lock expires | Yes (the ciphertext is locked) | **Yes**, and IAM can grant create-without-delete |
| Per-workspace retention | App only | App only | One floor per prefix; rules are per prefix (cap about 1,000, so per-workspace rules do not scale); a start of "later of upload and closeout" cannot be expressed (locks run from object creation) | Same as C | **Native**: retain-until is set per object at write, so workspace policy and the closeout start fit |
| Legal hold | App only | App only | App only (no per-object hold) | App only | **Native per-object legal hold** (maps directly onto C4 holds) |
| **Lawful early erasure** | App-level exception path (not designed) | Same as A | **Not possible per object.** Only: remove a lock rule (account admin; coarse; removes protection for everything under that prefix), shard rules per customer (rule cap), or don't offer it | **Destroy the key** (recorded in the ledger); backups holding the same ciphertext are shredded too | **Governance bypass** by the deletion runner's role only, with a recorded legal approval. (Compliance mode would make this impossible by design.) |
| Effect on C3 restore | None | None | A corrupted locked primary cannot be overwritten, so restore must write a new key and repoint the database; a deleted primary cannot occur before expiry | Same as C | New object versions; versioning must be on |
| Other costs and risks | None | Splits finalise into untrusted processing and a publisher; more moving parts, no provider guarantee | Locked orphans from lost finalise races unless objects are published only after the database commit; a second bucket; fixed-floor mismatch; lock removal by admin | Key management (no KMS on Railway or R2); losing keys loses data; key backups defeat shredding; ProofPack/PDF must decrypt; legal standing of "destroying the key" as erasure | Move evidence off Railway/R2 (an AU region helps residency); versioning storage cost; new provider account and IAM; backup design (a different provider or region) |
| New infrastructure | None | One bucket, one service | One bucket | KMS or HSM | A new provider |
| Reversibility | Easy | Moderate | Hard: a lock cannot be shortened by the application, and the retention period is long | Moderate (re-encrypt) | Moderate (migrate off) |

## What each option means for the C4 design

- **Ledger:** unaffected in A, B, D, E; in C it uses the same R2 lock mechanism (an indefinite rule on `v1/`), which is what C4 already requires. Any option should keep the ledger on a bucket with a lock and the ledger probe.
- **Deletion runner:** under C and D it can delete only after the lock expires (matching the "no retention override" rule). Under E it can delete after expiry, or earlier only through the governance-bypass role.
- **`EVIDENCE_PROVIDER_ISOLATION`:** the attestation value should become a real check once an option is chosen (for E, "the normal role cannot delete a locked version" can be probed with the normal credentials the same way the ledger is probed today). Until then the gate stays, and production destructive operations stay unavailable.
- **Backups:** need the same lock treatment as primaries, otherwise the backup worker's token is the weak point.

## Recommendation

1. **Do not build B alone** on R2 or Railway: it adds structure without a provider-level guarantee.
2. **The deciding question is legal, and it comes first:** must specific evidence ever be erasable *before* the retention floor, and would destroying a key count as erasure? If **no**, C (R2 locks plus staging split) is the simplest real isolation, with a fixed floor and a redesigned restore. If **yes**, the real choices are **E** (governance mode, your preferred direction) or **D**. E gives per-object retention, native legal holds, a bypass path with an audit trail and proper IAM isolation, at the cost of a new provider.
3. **Investigate E before committing** (no code, no production): (a) which providers offer S3 Object Lock with governance mode and an Australian region, including whether Railway's or R2's ecosystem has an equivalent; (b) whether the AWS SDK presign + conditional write + Object Lock headers interact correctly with our upload and restore paths; (c) cost of versioned storage at expected volumes; (d) IAM policy design (put/get without delete for normal roles; a separate bypass role for the runner); (e) how backups are protected (a second provider or region).
4. **Cheap staging check regardless (needs a throwaway R2 bucket):** add a lock rule, then with a *normal* token confirm that overwrite and delete are refused, record the error codes, and confirm `If-None-Match` still works (the ledger probe depends on it).

## Questions for counsel and product

1. Must early erasure of specific evidence be possible before the retention floor? Under what authority, and how is it recorded?
2. Does destroying an encryption key count as erasure of the evidence?
3. Is retention measured from upload, from job closeout, or the later of the two (R2 locks can only express age from creation)?
4. May locked objects exist for the whole retention period for files that were uploaded but never became evidence (rejected or lost-race files)?
5. Where must evidence be hosted for residency (AU)? Do backups need a different provider or region?
6. Who may hold the governance-bypass role (if E), and under what dual control?

## Explicitly not done

No permanent R2 evidence locks, no crypto-shredding, no bucket migration, no staging-bucket split, no new infrastructure and no change to the Railway/R2 architecture.
