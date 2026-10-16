# Evidence photos: open security risks (production blockers)

Status: living register. An item stays here until it is resolved and verified, not merely planned. Last updated 2026-10-16. Production evidence uploads, backups, automatic deletion and destructive operations remain disabled; **every OPEN item below blocks enabling them in production.**

## R-1 (OPEN): the R2 backup writer's token can delete backups; the backup is not provider-enforced deletion-proof

* **What is known** (Cloudflare R2 documentation, read 2026-10-16): API tokens come in four levels: Admin Read & Write, Admin Read only, Object Read & Write, Object Read only. Object tokens can be limited to named buckets and given an expiry, and temporary credentials can be derived from them. **None is documented as "write without delete".** The lowest level that writes is Object Read & Write.
* **What this means**: whoever holds the backup-writer credential (the worker, or anyone who obtains the secret) should be assumed able to overwrite and delete backup objects. Earlier documents (C3 runbook, C3 verification notes, PR C plan) described a "no-delete R2 token" as a provider-enforced control. **That description is withdrawn.** The backup must not be described anywhere as provider-enforced deletion-proof, tamper-proof or immutable.
* **What does protect it today (not provider-enforced)**: application code never calls delete on the backup store; the C4 delete-boundary check (`check:evidence-delete-boundary`) blocks store deletions in the upload routes; `EVIDENCE_DELETE_*` credentials must not be present on the API/backup service (the config fails closed); the restore operator uses a separate read-only token. These stop mistakes and a compromised *API*, not a compromised backup worker, a leaked token, or a malicious operator.
* **Required before production**: decide the isolation model in the C4b provider-isolation work (options include object lock/versioning with a role that cannot bypass it, a second provider or account the writer cannot reach, a write-then-seal process, or an out-of-band integrity ledger checked by a separate party); then verify by test that the chosen credential cannot delete or overwrite. The staging plan includes one attempted `DeleteObject` with the backup token to document actual behaviour; that result informs but does not replace the decision.
* **Owner decision needed**: accept, mitigate or re-architect. Until decided: OPEN.

## R-2 (OPEN): the Railway primary bucket has a single full-access credential and no object lock, versioning or lifecycle

Per Railway documentation (2026-10-16) a bucket has one access key pair per bucket instance (no scoped or read-only keys), and object versioning, object locks and bucket lifecycle configuration are not supported; there are no automatic backups. Anyone holding the key can delete or overwrite primary evidence. Mitigation depends on R-1's decision (an independent, tamper-resistant second copy) and on keeping the key only on the services that need it. OPEN.

## R-3 (OPEN): malware scanning is not implemented

Replaceable scanning integration with a tested fail-closed policy is required before production (existing release gate). OPEN.

## R-4 (OPEN, legal): data location

Neither Railway (nearest `sin` Singapore) nor R2 (best-effort Oceania hint) offers a guaranteed Australian region. Cross-border storage of site photos needs legal review (existing gate). OPEN.

## R-5 (OPEN): provider behaviour not yet measured

Railway and R2 CORS, signed content-type/length enforcement, expired-signature behaviour (R2 expired presigned URLs carry no CORS headers, so a browser sees a network error), and conditional writes (Railway undocumented) have been measured only against a local S3-compatible server. The staging plan measures them. OPEN.

## Related, not security: CI flake on master

`tests-db/mailbox-oauth.test.ts` "callback connects the mailbox..." asserts an audit row immediately after a response, but the route records it fire-and-forget (`void recordAudit(...)`), so it can fail under load. It failed once on master `32dd398` (unrelated to evidence photos) and passed on the same code elsewhere. Proposed fix: poll for the audit row in the test (test-only change), as its own PR.
