# Runbook — PlanningAlerts credential exposure (audit D1)

**Status: prepared, NOT executed. (Updated 2026-10-12 for the live topology.)** Every step that touches production needs explicit
approval from the owner. Nothing here has been run against production.

## Background
Before the D1 fix, `FetchTimeoutError` embedded the full request URL. PlanningAlerts takes
its API key as `?key=`, so a timeout could persist the key into
`DiscoverySourceState.lastError` and expose it via `GET /api/opportunities` and the admin
diagnostics modal. After the fix new errors are scrubbed on write, and every read path masks
`key=`/`token=`-style parameters, so already-stored rows are no longer *displayed*. They are
still *stored* until cleaned below.

## 0. Preconditions
- Fix deployed (otherwise new leaks keep arriving). Owner approval for each numbered step.
- Know whether `PLANNINGALERTS_API_KEY` was ever set in the target environment. If it was never
  set, the source was never called with a key: stop after step 1 if the check is clean.

## 1. Check (read-only)
```
DATABASE_URL=<read-only replica or prod URL> node scripts/check-leaked-source-errors.mjs
```
Prints row counts and `workspace=… source=…` identifiers only — never the matched text.
Exit 0 = clean; exit 1 = at least one row contains a credential-like parameter.
Also consider whether the leaked text could exist elsewhere: application logs, log drains,
Sentry events, backups/snapshots of the DB. Search them for `key=` against the PlanningAlerts
host and the first/last 4 chars of the key (never paste the full key into a ticket).

## 2. Assess exposure (decision, owner)
Who could have seen it: any workspace member of an affected workspace (via the opportunities
API) and platform admins. A key shared across tenants means every tenant's members are in
scope. Record the window: from first `PLANNINGALERTS_API_KEY` set until fix deploy.

## 3. Rotate (owner approval required — do this BEFORE scrubbing)
1. Issue a new key in the PlanningAlerts dashboard (Standard plan holder).
2. Set `PLANNINGALERTS_API_KEY` to the new key in the production environment.
3. Restart/redeploy the worker; run one sweep; confirm the source reports healthy.
4. Revoke the old key in the PlanningAlerts dashboard.
Rotating first matters: scrubbing the rows does not un-leak a key.

## 4. Scrub (owner approval required; take a DB backup first)
Run inside a transaction and check the row count matches step 1 before COMMIT:
```sql
BEGIN;
UPDATE "DiscoverySourceState"
   SET "lastError"   = regexp_replace("lastError",   '([?&;](api[_-]?key|key|token|secret|access[_-]?token|auth|password|sig|signature)=)[^&[:space:]"''<>)]*', '\1[redacted]', 'gi'),
       "lastWarning" = regexp_replace("lastWarning", '([?&;](api[_-]?key|key|token|secret|access[_-]?token|auth|password|sig|signature)=)[^&[:space:]"''<>)]*', '\1[redacted]', 'gi')
 WHERE "lastError" ~* '[?&;](api[_-]?key|key|token|secret|access[_-]?token|auth|password|sig|signature)='
    OR "lastWarning" ~* '[?&;](api[_-]?key|key|token|secret|access[_-]?token|auth|password|sig|signature)=';
-- expect the same count the checker reported
COMMIT;  -- or ROLLBACK
```
Then re-run step 1: it must exit 0.

## 5. Residual copies
Purge or expire: log aggregator entries, Sentry events (delete or scrub), DB backups older
than the fix per your retention policy. Document anything that cannot be purged.

## 6. Record
Add an incident note: window, scope, rotation time, scrub counts, and who approved each step.
If any tenant's data could be implicated, assess notification obligations with counsel.

## Approval gates (nothing below happens without a written "yes" for that exact step)
| Step | Destructive / outward? | Approver | Approved (who / when / scope) |
|---|---|---|---|
| 1 Run `check-leaked-source-errors.mjs` (read-only) | No (reads only; prints IDs, never text) | Owner | |
| 3 Rotate the PlanningAlerts key (new key → set var → redeploy worker → revoke old) | **Yes – credential rotation, brief worker restart** | Owner | |
| 4 Scrub rows (`UPDATE … regexp_replace`) after a DB backup | **Yes – production data change** | Owner | |
| 5 Purge residual copies (logs/Sentry/backups) | **Yes – deletes telemetry** | Owner | |

## Live topology (read from the Railway/Sentry connectors on 2026-10-12, read-only)
- Production runs in the Railway project **ACAOS**, environment named **"Acaos "** (note the trailing space): services `@acaos/api`, `@acaos/worker`, `@acaos/web`, Postgres 18.6, Redis 8.2. All latest deployments were SUCCESS from `master` @ `c117df0`; **merges to `master` auto-deploy**, so the D1 fix (error scrubbing + read-path masking) is already live. Step 0's precondition is met.
- A second environment named **"production"** exists with one *staged, uncommitted* change on the legacy service `acaos` (since 2026-10-10). Review and discard or apply it deliberately; it is unrelated to D1.
- The leak could only exist if `PLANNINGALERTS_API_KEY` was ever set on the **worker** service. Check the variable **names** (not values) in the Railway dashboard first; if it was never set, step 1's result is expected to be clean and no rotation is needed.
- Sentry project `acaos` (org `benjamin-box`, EU region): search it for `planningalerts` + `key=` for step 5. Only one unresolved issue existed (an unrelated stale-chunk error).
- Run step 1 from a machine you control using a **read-only** database role; do not paste the connection string into tickets.
