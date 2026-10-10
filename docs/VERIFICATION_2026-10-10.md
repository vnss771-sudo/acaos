# Verification record — 10 Oct 2026

A full run of every automated test tier against commit `fb3801c` (merge of
PR #370: job variations, operator diagnostics, autonomous-outreach gate,
calibration holdout). This answers "does the release pass its own suite on the
pinned runtime?" It does **not** cover live integrations, production
configuration or customer value (see [Not covered](#not-covered)).

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

## Not covered

- **Live integrations**: Stripe (real keys and webhooks), OpenAI, discovery
  providers, mailbox send/receive and reply processing, Sentry. The suite stubs
  or fakes all of these.
- **Production preflight / configuration**: needs real credentials and release
  identity, which only the deployed environment has.
- **Docker images, load test, chaos suite**: not run in this pass.
- **Commercial validation**: whether contractors find work through ACAOS and keep
  paying. The [pilot runsheet](./pilot/PILOT_RUNSHEET.md) is the next step for
  that.
