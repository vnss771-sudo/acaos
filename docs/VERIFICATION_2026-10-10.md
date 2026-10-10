# Verification record — 10 Oct 2026

A full run of every automated test tier against commit `fb3801c` (merge of
PR #370: job variations, operator diagnostics, autonomous-outreach gate,
calibration holdout). This answers "does the release pass its own suite on the
pinned runtime?" The state of the live deployment's integrations is in
[Production integrations](#production-integrations-live-deployment). What
neither pass covers is under [Not covered](#not-covered).

## Environment

| | |
|---|---|
| Node | 26.11.1 (official linux-x64 tarball, SHA-256 checked against `SHASUMS256.txt`) |
| npm | 10.9.2 (the version pinned in `package.json`) |
| PostgreSQL | 16 (local cluster; `test:db:local` uses its own throwaway cluster) |
| Redis | local `redis-server` on :6379 |
| Browser | Chromium 141.0.7390.37, headless |
| Install | `npm ci` from the committed lockfile |

**Differences from CI:**

- Playwright 1.60 expects Chromium revision 1243 (153.x). The run used the
  container's preinstalled revision 1194 (141.x), mapped in via a scratch
  `PLAYWRIGHT_BROWSERS_PATH` rather than downloaded. CI installs its own browser.
- The E2E Postgres and Redis were local processes, not service containers. The
  database, credentials and env (`acaos_test`, `postgres:postgres`) matched
  `ci.yml`.

## Results

| Tier | Command | Result |
|---|---|---|
| Static checks | `npm run verify`: toolchain, boundaries, worker processors, tenant resources, send authorization, CSP, frontend mutations, shim imports, workflow pinning, monitoring assets, rollout contract, compose hardening, test tiers, critical test coverage, offline stub | All passed |
| Lint + typecheck | `npm run verify`: `eslint .`, `tsc` for shared, backend-core, api, web, worker | Passed |
| Unit | `npm test` (inside `verify`) | **2,174 / 2,174** passed, 92 suites, 0 skipped |
| Web | `npm run test:web` (inside `verify`) | **377 / 377** passed, 66 files |
| Build | `npm run build` (inside `verify`) | Passed |
| Database | `npm run test:db:local` (migrations applied to a fresh cluster) | **519 / 519** passed; coverage 87.09% lines / 76.47% branches / 80.12% functions, all above the thresholds in the `test:db` script |
| Redis | `npm run test:redis:local` | **29 / 29** passed |
| Browser E2E | `CI=1 bash scripts/with-tenant-guard.sh npm run test:e2e` | **16 / 16** passed; the tenant guard blocked no queries |

E2E coverage: AI Tools run contract, Stripe webhook idempotency, accepted quote
→ single delivery job, job closeout and reopen, stale SENDING recovery, campaign
launch, every hub under the strict nginx CSP, signup → onboarding (both
paths), the send-failure safety cases (suppression, unsubscribe, reputation,
SAFE_LAUNCH approval, unsafe mail provider), tenant non-disclosure, and refresh
revocation on logout.

Expected noise in the E2E log, not failures:

- `Stripe price check failed` comes from the startup price check. It runs
  against fake `price_e2e_*` IDs and can't reach Stripe.
- One `Unique constraint failed on the fields: (id)` is the replayed webhook
  delivery in the idempotency test being rejected, as intended.

## Dependency audit

`npm audit` on `fb3801c` reported one high-severity advisory:
`source-map-js` 1.2.1, [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
(event-loop DoS via crafted source-map section offsets). It is dev-only, used by
Vite/PostCSS and `@vitest/coverage-v8`, and not shipped in the API or worker
runtime.

The fix bumps the lockfile entry to `source-map-js` 1.2.2, still within the
`^1.2.1` ranges its dependents declare. `npm audit` then reports 0
vulnerabilities. `npm audit fix` would also have pruned unrelated orphaned
`@typescript/typescript-*` lockfile entries, so only the `source-map-js`
entry was changed.

After the bump, `npm run verify` and the E2E tier were re-run on the updated
lockfile. Results are in [Re-run after the audit fix](#re-run-after-the-audit-fix).

## Re-run after the audit fix

| Tier | Result |
|---|---|
| `npm run verify` (all static checks, lint, typecheck, unit, web, build) | Passed: unit **2,174 / 2,174**, web **377 / 377** |
| Browser E2E (tenant guard enforcing) | **16 / 16** passed; the tenant guard blocked no queries |

The database and Redis tiers were not re-run. `source-map-js` is used only by
the web build and coverage tooling, and those tiers run neither.

## Production integrations (live deployment)

Checked on 10 Oct 2026, after the deploy of `9756928` (the merge of PR #371).
The live app runs in the Railway project **ACAOS**, environment `Acaos `
(trailing space). The environment named `production` has no services. The API,
worker, web, Postgres and Redis services were all up.

**Method.** This is read-only evidence: Railway deploy logs for the API and
worker (3–10 Oct), the API request log, and the API service's variable *names*
(values were redacted and not read). The live URLs and `api.tenders.gov.au`
were blocked by the network policy of the environment doing the check, so the
`smoke:deploy`, `smoke:ai-provider` and `smoke:discovery-sources` scripts were
**not** run against production. Nothing in production was changed.

| Integration | Status | Evidence |
|---|---|---|
| **Stripe billing** | **Broken** | Every API startup in the window (28 of 28) logs `Stripe price check failed … Invalid API Key provided` for the live secret key. Neither plan price resolves, so checkout and plan assignment would fail for a real customer. |
| Discovery: AusTender | Working | Six-hourly sweeps since 7 Oct succeed; the 00:54 UTC run on 10 Oct found 2 new opportunities for the one workspace. Before 7 Oct, every run failed because AusTender reports an empty day as HTTP 400 (`errorCode 100`). `efdb778` (7 Oct) fixed that and the failures stopped. |
| Discovery: PlanningAlerts | Not set up | `PLANNINGALERTS_API_KEY` is not set. |
| OpenAI | Key set, never used | `OPENAI_API_KEY` and `OPENAI_MODEL` are set; no AI requests appear in the logged week. |
| Mailbox send and reply processing | Never used | SMTP and IMAP variables exist, but mailbox auto-sync reports `0/0 workspaces` and domain health checks 0 domains. No workspace has connected a mailbox, and follow-ups are off (`FOLLOWUPS_ENABLED`). |
| **Error monitoring (Sentry)** | **Not set up** | `SENTRY_DSN` is not set, so production errors reach only Railway's logs. |
| Database and Redis | Healthy | All 107 migrations applied. A Redis connect timeout on 6 Oct at 04:32 UTC coincided with a Postgres/Redis redeploy and recovered. |

Real usage in the window is light, from one account: opportunities, profile,
delivery quotes and jobs, and the delivery report. There were no Stripe
checkouts or webhooks, AI generation calls or email sends.

**Preflight gaps in the live configuration** (checked against
`scripts/preflight-contract.mjs`):

- **Release identity**: the deployment reports `0.0.0-dev` with no build time.
  `ACAOS_RELEASE_ID` and `ACAOS_RELEASE_VERSION` are not set.
- **Safety settings not set explicitly** on the API service:
  `SAFE_LAUNCH_MODE`, `REPUTATION_GUARD_MODE` (preflight requires `enforce`) and
  `COMPLIANCE_GATE_ENABLED`. Preflight fails each one that is left unset.
- **Database pool**: `DATABASE_URL` has no `connection_limit`, so the API falls
  back to its default pool size and warns on every start.

**Actions for the operator**, most urgent first:

1. Create or roll the live Stripe secret key, set `STRIPE_SECRET_KEY` on
   `@acaos/api` and `@acaos/worker`, and confirm both price IDs belong to that
   live account. The next API startup log shows whether the price check passes.
2. Set `SENTRY_DSN` before any pilot customer is onboarded.
3. Set `SAFE_LAUNCH_MODE=true`, `REPUTATION_GUARD_MODE=enforce`,
   `COMPLIANCE_GATE_ENABLED` (true or false, deliberately) and the release
   identity variables.
4. Prove AI and email end to end: connect one pilot workspace's mailbox, run
   one AI research or draft, and run `npm run smoke:ai-provider` and
   `npm run smoke:deploy` from a machine that can reach the live URLs.

## Not covered

- **Live integration smoke scripts**: `smoke:deploy`, `smoke:ai-provider` and
  `smoke:discovery-sources` against production. The status above comes from
  logs and configuration, not live calls.
- **Production preflight**: `npm run pilot:preflight` needs the real
  credentials, which stay in the deployed environment.
- **Docker images, load test, chaos suite**: not run in this pass.
- **Commercial validation**: whether contractors find work through ACAOS and keep
  paying. The [pilot runsheet](./pilot/PILOT_RUNSHEET.md) is the next step for
  that.
