# E3.3 — Tenant-isolated website evidence persistence

This is a library-only integration package; it does not register any HTTP endpoint, schedule cleanup, initiate crawls, create Signals, infer consent, or send emails.

- New `WebsiteEvidenceClaim` model has unique `(workspaceId, prospectId, claimId)` and cascading Workspace/Prospect deletion.
- The caller must pass a Prisma transaction; ownership check and upserts must run inside the same transaction.
- Raw website text is not retained. Only bounded source-attributed quotes, source hash, source URL and timestamps are stored.
- Claims retain `source_observed` / `unverified` semantics; the persistence model intentionally has no consent or verified fields.
- Default retention is 30 days, maximum 90. A future operator job must invoke `pruneExpiredWebsiteEvidence()` repeatedly in <=500-row chunks.
- No background job or application route is activated. Read APIs must require workspace membership and verify prospect ownership.
- BEFORE production: review server-side URL pinning, HTML parser limitations, robots/crawl permissions and egress firewall; confirm legal retention; run Prisma generate, migration, unit, DB, and security tests under Node 26.
