# Data Retention & Deletion Policy

What ACAOS stores, how long it should be kept, and how a workspace's data is
exported or deleted. This is the policy of record for review finding P0-2/§6.2
("data retention policy"). The documented windows are enforced automatically by a
daily `retention-purge` worker job (`purgeExpiredData`); rows that fall outside a
window (e.g. lifecycle-bound data) are noted in the Enforcement column.

## Retention windows

| Data | Model / store | Default retention | Enforcement |
|---|---|---|---|
| Inbound email bodies processed for reply detection | `ProcessedEmail` | 90 days | Automated (daily purge job) |
| Outreach drafts (AI-generated copy) | `OutreachDraft` | Life of the lead; purged with the workspace | With tenant deletion |
| Sent-outreach records (delivery/outbox) | `OutreachSent` | 18 months (deliverability/audit) | Automated (daily purge job) |
| AI research / enrichment results | `Lead.aiSummary`, `Signal`, `EvidenceSource` | Life of the prospect/lead | With tenant deletion |
| Provider discovery runs | `DiscoveryRun` | 12 months | Automated (daily purge job) |
| Audit events | `AuditEvent` | 24 months (append-only, FK-free by design) | Automated (daily purge job) |
| Product-analytics events | `AnalyticsEvent` | 12 months (`RETENTION_ANALYTICS_EVENT_DAYS`; append-only, FK-free) | Automated (daily purge job) |
| Refresh tokens | `RefreshToken` | Expire per `REFRESH_TOKEN_DAYS`; revoked rows purged after 30 days | Expiry + automated (daily purge job) |
| Email-verification / password-reset tokens | `EmailVerificationToken`, `PasswordResetToken` | Until used or expired; purge after 30 days | Expiry + automated (daily purge job) |
| Stripe event dedupe keys | `ProcessedStripeEvent` | 12 months | Automated (daily purge job) |
| Mailbox credentials | `WorkspaceEmailConfig` | Until removed by the workspace | Encrypted at rest (`EMAIL_ENCRYPTION_KEY`) |

Prompts and raw model inputs/outputs are not persisted beyond the derived fields
above (e.g. `aiSummary`, draft `subject`/`emailBody`). The OpenAI request itself
is transient.

## Tenant export

A workspace owner can obtain their data:
- **Leads** — `GET /api/leads/export?workspaceId=…` (CSV, cursor-paginated, bounded).
- A full structured export (prospects, signals, campaigns, outcomes) is a roadmap
  item; until then it is produced on request via an operator script scoped by
  `workspaceId`.

## Tenant deletion

On workspace deletion, all workspace-scoped rows are removed. Records that are
intentionally FK-free for integrity (`AuditEvent`) are deleted by `workspaceId`
filter rather than cascade. Deletion must:
1. Revoke ingest API keys and refresh tokens for the workspace.
2. Remove `WorkspaceEmailConfig` (and thus stored mailbox credentials).
3. Delete leads, prospects, signals, evidence, drafts, sent records, discovery
   runs, outcomes, and campaigns for the `workspaceId`.
4. Delete `AuditEvent` rows for the `workspaceId` after the export window, if any.

A single transactional `deleteWorkspace(workspaceId)` operation that performs the
above and writes a final audit record is the roadmap target; today the steps are
run via an operator script.

## Roadmap

1. ~~Scheduled purge job honouring every window above.~~ **Done** — the daily `retention-purge` worker job (`purgeExpiredData` in `packages/backend-core/src/lib/retention.ts`) enforces every window; windows are overridable via `RETENTION_*` env vars. Tests: `tests-db/retention.test.ts`.
2. One-call workspace export (structured) and transactional delete.
3. Configurable per-plan retention windows.
