# Recovery & Disaster Recovery (DR)

Backup posture and tested-restore procedures for ACAOS. Addresses the readiness-review
gap: "automated backups on" was a bare go-live checkbox with no provider, retention,
RTO/RPO, or **tested** restore. This is the operator-facing runbook; fill the
platform-specific blanks (marked `‹…›`) for your deployment.

## Targets

| | Target | Notes |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 min | Continuous WAL / point-in-time recovery (PITR). |
| **RTO** (time to restore) | ≤ 1 hour | DB restore + app redeploy + smoke. |

Postgres holds all durable tenant data (billing, leads, sends, audit). It is the only
component with a hard RPO — see **Redis** below for why job/cache state is disposable.

## Postgres — backups

- **Provider:** ‹Railway managed Postgres / Render / RDS / Neon›. Enable **automated
  daily snapshots + PITR (WAL archiving)**. Retention: **≥ 7 days** snapshots, PITR
  window **≥ 24h** (raise to 30d/7d for paid GA).
- **Encryption:** at rest (provider-managed) + in transit (TLS — `DATABASE_URL` uses
  `sslmode=require`).
- **What's covered:** every table. Migrations are additive/nullable (no destructive
  down-migrations), so a forward-only restore never needs schema rollback.
- **Verify backups exist:** ‹provider console / `‹cli› backups list›› — check weekly
  that the most recent snapshot is < 24h old.

## Postgres — restore (run the drill before relying on it)

1. **Stop writes:** scale the API + worker to 0 (or enable a maintenance page) so no
   new rows race the restore.
2. **Restore** to a new instance at the target timestamp:
   - Snapshot: ‹provider restore-from-snapshot›
   - PITR: ‹provider PITR to `YYYY-MM-DDTHH:MM:SSZ`›
3. **Point the app** at the restored DB: update `DATABASE_URL` / `DIRECT_URL`.
4. **Reconcile schema:** `node scripts/start-with-migrations.mjs` runs `prisma migrate
   deploy` (safe, additive) on boot — confirm it reports no pending migrations and the
   server starts.
5. **Smoke:** `npm run smoke:api` + a manual login/leads/billing check
   (`docs/SMOKE_TESTS.md`). Optionally enable `STATS_RECONCILE_ENABLED=true` for one
   cycle so `CampaignDailyStats` re-derives from the `ContactEvent` ledger.
6. **Resume:** scale API + worker back up.

> **Drill cadence:** restore to a throwaway instance **quarterly** and record the
> measured RTO here: `last drill: ‹date› — RTO ‹mm:ss›`. An untested backup is not a
> backup.

## Redis — persistence stance

Redis holds **disposable** state: BullMQ job queues, rate-limit counters, circuit-breaker
state, SSE tickets. None of it has an RPO.
- A Redis loss does **not** lose durable data. On reconnect: in-flight jobs that were
  mid-process are recovered as FAILED once their locks expire (BullMQ); stale `SENDING`
  outbox rows are swept to FAILED by the retention job (never double-sent); rate limits
  and breakers rebuild from zero.
- **Recommended:** enable AOF (`appendonly yes`) on the managed Redis so a restart
  doesn't drop queued-but-unstarted jobs. If AOF is off, document that queued jobs are
  best-effort and re-enqueue from source on a full Redis loss.

## Tenant-level recovery

- **Accidental workspace deletion:** the GDPR-erasure endpoint (`DELETE
  /api/workspaces/:id`) is irreversible by design (owner + step-up + typed-name
  confirm). Recovery = PITR to just before the deletion, then export the single
  workspace's rows. There is no soft-delete/undo.
- **Individual record:** restore a copy at the target time and copy the rows out.

## Related

- `docs/MIGRATIONS.md` — migration safety, the additive-only policy, and the Railway
  `prisma db push --accept-data-loss` warning (ensure the prod start command is
  `start-with-migrations.mjs`, **not** `db push`).
- `docs/runbooks/postgres-connection-exhaustion.md`, `docs/RUNBOOKS.md#dependencydown`.
- `docs/DATA_RETENTION.md` — retention windows + the erasure endpoint.
