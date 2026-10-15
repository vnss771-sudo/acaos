# Data Retention & Deletion Policy

What ACAOS stores, how long it should be kept, and how a workspace's data is
exported or deleted. The documented windows are enforced automatically by a
daily `retention-purge` worker job (`purgeExpiredData`); rows that fall outside a
window (e.g. lifecycle-bound data) are noted in the Enforcement column.

## Retention windows

| Data | Model / store | Default retention | Enforcement |
|---|---|---|---|
| Inbound email bodies processed for reply detection | `ProcessedEmail` | 90 days | Automated (daily purge job) |
| Outreach drafts (AI-generated copy) | `OutreachDraft` | Life of the lead; purged with the workspace | With tenant deletion |
| Sent-outreach records (delivery/outbox) | `OutreachSent` | 18 months (deliverability/audit); env override floored at 60 days so unsubscribe links keep working | Automated (daily purge job) |
| AI research / enrichment results | `Lead.aiSummary`, `Signal`, `EvidenceSource` | Life of the prospect/lead | With tenant deletion |
| Provider discovery runs | `DiscoveryRun` | 12 months | Automated (daily purge job) |
| Audit events | `AuditEvent` | 24 months (append-only, FK-free by design) | Automated (daily purge job) |
| Product-analytics events | `AnalyticsEvent` | 12 months (`RETENTION_ANALYTICS_EVENT_DAYS`; append-only, FK-free) | Automated (daily purge job) |
| Refresh tokens | `RefreshToken` | Expire per `REFRESH_TOKEN_DAYS`; revoked rows purged after 30 days | Expiry + automated (daily purge job) |
| Email-verification / password-reset tokens | `EmailVerificationToken`, `PasswordResetToken` | Until used or expired; purge after 30 days | Expiry + automated (daily purge job) |
| Stripe event dedupe keys | `ProcessedStripeEvent` | 12 months | Automated (daily purge job) |
| Mailbox credentials | `WorkspaceEmailConfig` | Until removed by the workspace | Encrypted at rest (`EMAIL_ENCRYPTION_KEY`) |
| Ops crew shift records | `OpsShiftRecord` | 24 months (`RETENTION_OPS_SHIFT_RECORD_DAYS`; labor/compliance-adjacent, like AuditEvent) | Automated (daily purge job) |
| Ops fatigue/compliance alerts | `OpsAlert` | 12 months (`RETENTION_OPS_ALERT_DAYS`) | Automated (daily purge job) |

Prompts and raw model inputs/outputs are not persisted beyond the derived fields
above (e.g. `aiSummary`, draft `subject`/`emailBody`). The OpenAI request itself
is transient.

## Evidence files, retention settings and legal holds (schema only — not active)

Migration `20261015000000_evidence_file_metadata` adds the tables that a later
phase will use for technician photo evidence: `EvidenceFile` / `EvidenceFileCopy`
(metadata and storage locations only, never file contents), `RetentionPolicy`,
`LegalHold` and `EvidenceDeletionLog`. **Nothing reads or writes them yet, and no
automatic deletion exists.** Design intent, subject to legal review (see
`docs/plans/PR_C_EVIDENCE_STORAGE_PLAN.md`):

- Default retention for job evidence and reports is seven years (`RetentionPolicy.retentionDays`, 2555), configurable per workspace; `autoDeletionEnabled` is `false` and is not consulted by any job.
- A legal hold (workspace-wide or per job) blocks deletion until released. Placing/releasing and approving any deletion is limited to workspace owners, enforced by the endpoints when they are built.
- `EvidenceDeletionLog` is append-only (a trigger rejects UPDATE/DELETE) and FK-free so it outlives the rows it describes, like `AuditEvent`.
- **Interaction with tenant deletion:** files, copies and holds use `ON DELETE RESTRICT`, so deleting a workspace/job/crew member that still has them is refused by the database rather than silently destroying the record. `RetentionPolicy` is configuration and cascades. **`DELETE /api/workspaces/:id` now explicitly refuses (409, with an explanation) while the workspace has any evidence file row (including `DELETED` tombstones) or any legal hold (active or released), and nothing is removed.** Erasure of such a workspace needs the controlled evidence-deletion process and a legally reviewed reconciliation of erasure requests with retention; neither exists yet, so those workspaces cannot currently be erased through the product.

## Tenant export

A workspace owner can obtain their data:
- **Leads** — `GET /api/leads/export?workspaceId=…` (CSV, cursor-paginated, bounded).
- A full structured export (prospects, signals, campaigns, outcomes) is a roadmap
  item; until then it is produced on request via an operator script scoped by
  `workspaceId`.

## Tenant deletion

On workspace deletion, all workspace-scoped rows are removed, **except that a workspace with retained evidence files or legal holds cannot be deleted at all until they are resolved** (see "Evidence files, retention settings and legal holds" above). Records that are
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
