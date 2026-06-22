# ACAOS Incident Runbooks

Component- and incident-oriented runbooks for the ACAOS outreach platform
(API `apps/api`, worker `apps/worker`, shared `packages/backend-core`).

These complement, and do not replace, the alert-keyed first-response procedures
in [`../RUNBOOKS.md`](../RUNBOOKS.md) (one section per
`ops/monitoring/alerts.yml` alert). Use **that** file when a named alert fires;
use **these** when you're diagnosing a failing subsystem (Redis, Postgres,
Stripe, a provider, sending) and need depth: symptoms → mitigation → rollback →
customer comms → follow-up.

SLO targets and alert thresholds: [`SLO.md`](SLO.md) (and the formal table in
[`../SLO.md`](../SLO.md)). Operational background: [`../OPERATIONS.md`](../OPERATIONS.md),
[`../DEPLOYMENT.md`](../DEPLOYMENT.md), [`../MIGRATIONS.md`](../MIGRATIONS.md).

## Runbook index

| Runbook | When to reach for it |
|---|---|
| [`redis-outage.md`](redis-outage.md) | Redis/BullMQ unreachable; jobs stall; rate-limit/breaker degraded |
| [`postgres-connection-exhaustion.md`](postgres-connection-exhaustion.md) | `/api/ready` flaps, "too many connections", pool timeouts |
| [`stripe-webhook-failure.md`](stripe-webhook-failure.md) | Webhook 4xx/5xx, signature failures, plan/subscription drift |
| [`openai-provider-outage.md`](openai-provider-outage.md) | AI queues failing in bursts; `openai` circuit OPEN |
| [`smtp-provider-failure.md`](smtp-provider-failure.md) | Sends FAILED en masse; SMTP rejects/timeouts |
| [`imap-auth-failure.md`](imap-auth-failure.md) | Mailbox sync failing; replies/bounces not ingested |
| [`stuck-campaign-send.md`](stuck-campaign-send.md) | `OutreachSent` rows stuck `SENDING`; send job hung |
| [`high-bounce-rate.md`](high-bounce-rate.md) | Bounce/complaint spike; sender reputation at risk |
| [`reputation-guard-enforcement.md`](reputation-guard-enforcement.md) | Sends halted by the reputation guard (enforce mode); "why did sends stop?" |
| [`followups-not-sending.md`](followups-not-sending.md) | Follow-up backlog growing; tasks stuck or follow-ups disabled |
| [`warmup-not-progressing.md`](warmup-not-progressing.md) | A workspace's warmup ramp is stuck / capped lower than expected |
| [`accidental-over-sending.md`](accidental-over-sending.md) | Too many emails going out; need an emergency stop |
| [`failed-migration.md`](failed-migration.md) | `prisma migrate deploy` failed or partially applied |
| [`suspected-data-breach.md`](suspected-data-breach.md) | Suspected unauthorized access / data exposure |

## How to use a runbook

1. **Confirm scope.** One workspace/target or platform-wide? Check the Grafana
   "Service Overview" dashboard, `/api/ready`, and the worker `/metrics`.
2. **Check recent deploys.** Most incidents correlate with a deploy. Confirm the
   running release via the `X-Acaos-Release-Id` header / `/api/ready` body. If
   correlated, **roll back first, diagnose second.**
3. Jump to the matching runbook and work top-to-bottom: Symptoms → Impact →
   Immediate mitigation → Diagnosis → Rollback → Customer communication →
   Prevention follow-up.
4. **Write it up** if it burned error budget (see `SLO.md`).

### Blast-radius levers (no deploy required)

ACAOS exposes env-only kill switches read live on every request/job
(`packages/backend-core/src/lib/launchControls.ts`) — flipping one takes effect
on the next request/job, no restart:

- `FEATURE_SEND` — disable email sending (worker skips `send-campaign`; API 503s
  the send route).
- `FEATURE_AI` — disable AI (research/outreach/reply-analysis jobs skip).
- `FEATURE_MAILBOX_SYNC` — disable IMAP sync.
- `FEATURE_DISCOVERY` — disable prospect discovery.
- `SAFE_LAUNCH_MODE=true` — force human approval of every outbound draft, no
  auto-send, and clamp every workspace's daily send cap to a low ceiling
  (`SAFE_LAUNCH_DAILY_SEND_CAP`, default 20).

> All default **ON** (SAFE_LAUNCH_MODE defaults OFF). Operators opt out
> explicitly. The API edge and the worker read the same source of truth, so the
> two layers can never disagree.

## Severity definitions

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **SEV1** | Platform-wide outage or active data risk. Customers cannot use core flows, OR data is being lost/exposed. | API down, Postgres down, suspected data breach, runaway over-sending in progress | Page on-call immediately; incident channel; all-hands until mitigated |
| **SEV2** | Major degradation; a core flow is broken for many but not all. | Worker stalled (jobs not draining), SMTP down (no sends), Stripe webhook processing failing, OpenAI outage blocking AI flows | Page on-call; mitigate within the hour |
| **SEV3** | Minor/partial degradation or single-tenant issue with a workaround. | One workspace's IMAP auth failing, elevated p95 latency, discovery failures | Ticket + business-hours fix; monitor budget burn |

Escalate a SEV up a level if it persists past its response window or the blast
radius grows (e.g. one workspace's bounce spike → platform sender reputation).

## On-call escalation shape

1. **Primary on-call** — acknowledges the page, runs the runbook, owns
   mitigation and comms. Declares severity.
2. **Secondary on-call** — backup if primary doesn't ack within 10 min, or for a
   second pair of hands on a SEV1/SEV2.
3. **Engineering lead / incident commander** — looped in on any SEV1 or a SEV2
   running past 30 min; owns the go/no-go on rollback, feature-flag kills, and
   external comms.
4. **Founder / DPO** — required for `suspected-data-breach.md` (legal/regulatory
   notification clock) and any customer-data exposure.

Roles can collapse onto one person in a small beta team — but the **decisions**
(declare severity, roll back, flip a kill switch, notify customers) must each
have a named owner before acting.
</content>
