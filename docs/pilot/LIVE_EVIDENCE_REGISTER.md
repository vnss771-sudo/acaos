# ACAOS live launch evidence register

**Created:** 2026-10-13. **State:** Historical evidence only; not a production verification.

## Rules

- `UNVERIFIED` is the default; never infer LIVE VERIFIED from source checks, fixtures or historical notes.
- Record the exact UTC time, independent verification method, accountable owner, redacted evidence link, and recheck trigger before changing an item to `LIVE VERIFIED`.
- Never record credentials, environment-variable values, recipient addresses, tenant IDs or other sensitive identifiers in this file.
- Keep autonomous outreach and Australian commercial sending disabled unless the documented legal, owner and technical approvals have been completed.
- Distinguish production environment `Acaos ` (trailing space) from legacy environment `production`; do not apply or discard any staged changes as part of a documentation update.

| Control | Snapshot observation (date) | Live-verified UTC | Method | Owner | Status | Redacted evidence | Recheck trigger |
|---|---|---|---|---|---|---|---|
| Node/build CI gate | `npm run verify` passed locally using Node 26.11.1/npm 10.9.2 (13 Oct) | — | Local archive review | Engineering | STATIC VERIFIED; NOT LIVE VERIFIED | `ACAOS_launch-readiness_review.md` | On commit or dependency change |
| Live deployed release identity | Prior source describes `master` at `c117df0` (12 Oct) | — | Inspect deployed release + smoke | Operations | UNVERIFIED CURRENT | `docs/pilot/PILOT_READINESS.md` | Each deployment |
| Stripe account and price mapping | Starter/Growth mapped; Contractor Pro not mapped (12 Oct) | — | Redacted dashboard/config inspection | Owner | UNVERIFIED CURRENT | `docs/pilot/PILOT_READINESS.md` | Pricing/config change |
| Stripe automatic tax/GST | Tax-exclusive prices; actual env value unknown (12 Oct) | — | Approved tax/config review | Owner + tax advisor | UNVERIFIED | — | Pricing/config change |
| Stripe paid subscription workflow | End-to-end real charge not exercised in archive review | — | Owner-approved paid/test flow | Owner | UNVERIFIED | — | Billing change |
| Australia workspace/jurisdiction targeting | Workspace flag opt-in gap observed in review (13 Oct) | — | Shared-send-gate tests + aggregate rollout preflight | Engineering + legal | BLOCKED | `ACAOS_launch-readiness_review.md` | Policy/gate change |
| Australian legal policy | Written counsel approval not evidenced (13 Oct) | — | Signed counsel and owner decision | Legal + owner | BLOCKED | — | Legal/policy change |
| SMTP/domain authentication | Real production send not proven (13 Oct) | — | Approved owner-controlled self-send + SPF/DKIM/DMARC | Owner + operations | UNVERIFIED | — | Mailbox/domain change |
| IMAP/reply/unsubscribe | Production ingestion not proven (13 Oct) | — | Owner-controlled reply and suppression check | Owner + operations | UNVERIFIED | — | Mailbox/send change |
| ABR live lookups | ABR GUID and live active/cancelled/invalid checks open (12 Oct) | — | Redacted live provider smoke or explicit scope deferral | Owner | UNVERIFIED | — | Feature/config change |
| PostgreSQL backup / PITR restore | Restore drill not evidenced (13 Oct) | — | Isolated restore; RTO/RPO measurement | Operations | UNVERIFIED | — | Storage/backup change |
| API and worker Sentry / alerting | Web events exist; API/worker not evidenced (12 Oct) | — | Controlled staging/production instrumentation event | Operations | UNVERIFIED | — | Release/alert change |
| Legacy `production` staged change | Staged legacy service change reported (12 Oct) | — | Owner decision: apply/discard | Owner | ACTION REQUIRED | — | Environment change |

## Go/no-go

**Supervised pilot sending:** NO-GO until all P0 gates and explicit approvals are documented. ABR may be deferred only with an owner-approved scope change. A first test must use an owner-controlled address and explicit authorization.

**Public launch:** NO-GO until pilot criteria plus verified restore, operational alerting/ownership, privacy/retention and deployment-environment decisions are recorded.
