# Handoff: moving Railway production onto this repo (2026-09-28)

Picks up an in-progress production migration. Read all of this before
touching Railway: production has already had one outage from this work.

## TL;DR

- Production runs on Railway from a **different repo**
  (`bgb87b-cmd/acaos-fieldops-patched-3`), not `vnss771-sudo/acaos`. None of
  this repo's work since early September is live.
- The production database was built by that repo, so its migration history
  **diverges** from this repo's. A naive source switch crashed the API for about
  80 minutes on 2026-09-27; it was restored.
- The plan below (backup, then audit, reconcile, rehearse, cut over) is
  **stopped at Phase 0**, because the Railway connection could not create any
  services.
- **First thing to do:** confirm which Railway account you're connected to (see
  the blocker below).

## Blocker: Railway account and plan

- The previous session's Railway MCP was authenticated as **`bgb87b-cmd` /
  bgb87b@gmail.com** (account id `19607ddd-bf50-4450-b151-8c38de8c6a0c`),
  workspace **"Ben BOX's Projects"** (`3a58c604-63f3-492e-aa7e-f92cfc2bea60`).
  That workspace is on the **free plan**: every `create-service` and
  `deploy-template` call failed with *"Free plan resource provision limit
  exceeded"*.
- The owner's own Railway account is **`vnss771-sudo` / vnss771@gmail.com**,
  workspace "Ben Box's Projects", on **Hobby**. They reconnected the connector
  as vnss771, but the old session kept the old token.
- **Check first:** call `whoami` and `list-projects`.
  - If `enthusiastic-appreciation` is **not** visible under the vnss771
    account, it still lives in the bgb87b workspace. The owner needs to transfer
    it to their Hobby workspace (or upgrade the bgb87b workspace) before any
    phase can run.
  - If it is visible and `create-service` works, resume at Phase 0.

## Production inventory (Railway project `enthusiastic-appreciation`, id `b91184ec-3d50-4a79-93a0-be6c2bd9ef26`, env `production` `8e5a8c53-da5d-47f2-9276-e04432bda8da`)

| Service | ID | Source | State |
|---|---|---|---|
| `@acaos/api` | `fef89570-b411-4343-8b1b-49138cff9e20` | patched repo, **pinned to commit `10aac945`** | Up since 2026-09-27 22:38 UTC. Start command: `node scripts/start-with-migrations.mjs`. Pre-deploy command: none (a temporary one was added and then removed). **No healthcheck configured.** |
| `@acaos/worker` | `1c37f910-20e6-4209-9e89-6159b79a3d91` | patched repo `master`, **not pinned** (a push there would redeploy it) | Healthy. Builder is Railpack. |
| `@acaos/web` | `d09d96fa-a815-4714-8550-6ec91782d185` | patched repo `master` | Untouched. Var: `VITE_API_BASE_URL`. |
| `Postgres` | `f4746d6b-69cf-4fcc-b7b3-380bb9f30449` | `postgres-ssl:18` | 500 MB volume. **No public TCP proxy** (private network only). No backups configured. |
| `Redis` | `2ae2a3e6-df72-4f3d-b8f4-77e97b66b2a2` | `redis:8.2` | Unchanged. |
| bucket `db-backups` | `01fa5901-56c7-4b75-af6e-dc54fcbf87f5` | region iad | Created for Phase 0. **Empty.** |

Changes made on 2026-09-27/28:
- **Worker variables:** the worker previously had **no variables** and crash-looped
  on `redis://localhost:6379`. Set as references, no values copied:
  - `REDIS_URL=${{Redis.REDIS_URL}}`
  - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
  - `DIRECT_URL`, `EMAIL_ENCRYPTION_KEY` and `JWT_SECRET` as `${{@acaos/api.*}}`
- **API variables** (names only): `ALLOWED_ORIGINS`, `DATABASE_URL`,
  `DIRECT_URL`, `EMAIL_ENCRYPTION_KEY`, `JWT_SECRET`, `REDIS_URL`, `WEB_URL`.
- **Unset in production** (feature-gated warnings at boot): `OPENAI_API_KEY`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `METRICS_TOKEN`.

## What happened on 2026-09-27 (incident)

1. The API source was switched to `vnss771-sudo/acaos@master`.
2. `prisma migrate deploy` applied nothing from the shared 71 migrations, then
   ran `20260912215055_ops_module_foundation`. It failed with
   `relation "OpsCrewMember" already exists` (Postgres error `42P07`, Prisma
   `P3018`), and every retry after that hit `P3009`.
3. **Railway removed the previous deployment before the new one was healthy**,
   because there's no healthcheck. The API was down from about 21:17 to
   22:38 UTC.
4. The fix:
   - Pointed the API back at the patched repo, pinned to `10aac945`.
   - A one-off pre-deploy step ran
     `prisma migrate resolve --rolled-back 20260912215055_ops_module_foundation`
     (log confirmed: "marked as rolled back").
   - `migrate deploy` then reported "No pending migrations".
   - The pre-deploy step has since been removed.
   - That migration's row in `_prisma_migrations` is now marked rolled back.

**Lesson: configure a healthcheck (`/api/ready`) before any further source
change.**

## Migration divergence

- **Shared:** the first **71** migrations, up to and including
  `20260625150000_webhook_endpoint`. Production had all of them applied (74 in
  its folder at the time).
- **Only in production (3), from the patched repo:** per
  `docs/COMPARISON_acaos-fieldops-patched.md`, almost certainly:
  - `20260826000000_mission_icp_overrides`: adds **`Mission.icpOverrides`**
    (plural, JSONB).
  - `20260903000000_ops_module_foundation`: the 5 Ops tables.
  - `20260903120000_ops_endtime_nullable`: makes `OpsShiftRecord.endTime`
    nullable.

  **Verify the exact names in the audit.**
- **Only in this repo (11):**

| Group | Migrations | Notes |
|---|---|---|
| A. Ops (conflicts) | `20260912215055_ops_module_foundation`, `20260914061446_ops_crew_member_user_link`, `20260914114217_ops_alert_shift_type_unique` | Tables already exist in production. Our foundation also has a partial unique index `OpsShiftRecord_open_shift_per_crew_member` and enums (`OpsJobStatus`, `OpsRiskLevel`, ...) that the patched version may not have. **Diff before deciding.** |
| B. Independent, additive | `prospect_lead_conversion`, `dpa_acknowledgement`, `user_last_login_at`, `mission_icp_override`, `inbox_list_query_optimization`, `email_config_domain_health`, `inbox_reply_send` | Nullable columns, one index, one new table. Old code still runs after they're applied. |
| C. Depends on A | `20260925010000_work_discovery` | `Opportunity.opsJobSiteId` references `OpsJobSite`. |

**Known data hazard:** this repo's column is **`Mission.icpOverride`**
(singular, `schema.prisma:318`), but production likely has
**`icpOverrides`** (plural). Applying `mission_icp_override` as-is would
orphan any overrides already stored. The reconciliation must copy
`icpOverrides` into `icpOverride` where set. Drop the old column only in a
later, separate migration.

## The plan (not started past Phase 0)

0. **Backup.** `pg_dump -Fc` production into the `db-backups` bucket, from a
   temporary job service using image `postgres:18` (the local `pg_dump` here is
   v16 and can't dump a v18 server). Keep data inside Railway. Also enable
   Railway's native scheduled Postgres backups (a paid-plan feature).
1. **Audit on a copy.** Restore the dump into a scratch Postgres service.
   Against the **copy**, run:
   - `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`
   - `prisma db pull --print`
   - `prisma migrate diff --from-url <copy> --to-schema-datamodel packages/db/prisma/schema.prisma --script`
   - row counts for `Ops*`, and `Mission` rows with `icpOverrides` set

   Read the results from the service's logs.
2. **Reconciliation PR** in this repo:
   - **Group A:** if the shapes match, `migrate resolve --applied` the three.
     Otherwise add one guarded, idempotent
     `reconcile_fieldops_patched_schema` migration (a no-op on fresh DBs), then
     resolve the three as applied in production only.
   - **Groups B and C:** apply as-is, with the `icpOverrides` copy step.
   - **The 3 production-only migrations:** leave them in the ledger. If
     `migrate status` complains that they're missing locally, add same-named
     no-op folders.
3. **Rehearse** on the copy: this repo's `start-with-migrations`, then boot the
   API against it and smoke test.
4. **Cut over:**
   - Add a healthcheck `/api/ready` to the API **first**.
   - Then move API, worker and web to `vnss771-sudo/acaos@master`, one at a
     time, verifying each. The one-off resolve commands go in a temporary
     pre-deploy step, removed afterwards.
   - **Rollback:** repoint to `10aac945`. If schema changes break old code,
     restore from the Phase 0 dump.
5. **Clean up:**
   - Delete the temporary services.
   - Unpin the API and follow `master` on all services.
   - Consider archiving the patched repo.

**Ask the owner before each change to a live service, and before deleting
anything.**

## Session and permission notes

- `.claude/settings.local.json` (gitignored) allow-lists read-only Railway MCP
  tools:
  - `list-deployments`
  - `get-logs`
  - `describe-service`
  - `list-services`
  - `get-deployment-diagnosis`
  - `get-status`
  - `environment-status`

  A new session will need its own copy; the file isn't committed.
- The auto-mode permission checker blocked:
  - Railway reads until they were allow-listed;
  - creating Railway resources until the owner explicitly approved it;
  - attaching the patched repo (`add_repo`);
  - a force-push on this branch.
- **Branch state:** `claude/project-status-2655kf` = old #299 commit plus a
  `.gitignore` commit, plus this note. The owner chose to leave the history as is.

## Other state

- **PR #299** (merged): fixed `release.yml`, which GitHub had been rejecting
  (secrets in `if:`). The first real test is the next `v*.*.*` tag.
- **Stale items** (unchanged):
  - Dependabot PRs #263 and #266 are open.
  - June PRs #110, #111 and #115 are stale.
  - Issue #217 holds the audit backlog.
  - `CHANGELOG.md` and `ENGINEERING_ROADMAP.md` are out of date.
