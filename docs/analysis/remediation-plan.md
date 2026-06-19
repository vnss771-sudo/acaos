# ACAOS Remediation Plan — Full Analysis Report (FA-01…FA-08)

> Source: external static-analysis report `acaos_full_analysis_report_20260619.md`.
> Every finding below was **re-validated against the current codebase** (not the
> report's zip snapshot) before being turned into a ticket. Evidence is given as
> `file:line`. This document is the actionable, sequenced plan derived from that
> report.

## Validation result (all CONFIRMED against current code)

| ID | Finding | Key evidence |
|---|---|---|
| FA-01 | Provider `fetch` lacks timeout/abort | `apps/api/src/lib/prospectSources.ts` (Apollo search — breaker only; Google Places — no breaker, no timeout); `packages/backend-core/src/services/apollo.ts` (breaker only); `packages/backend-core/src/services/hunter.ts` `findContactEmail` + `verifyEmail` (no breaker, no timeout). OpenAI (`openai.ts`) + SMTP/IMAP (`mail.ts`) already have timeouts. |
| FA-02 | Inconsistent route validation | Zero `validate()` in `leads`, `billing`, `outcomes`, `ingest`, `ai`; partial in `campaigns`, `prospects`, `workspaces`, `jobs`, `mailbox`, `packs`, `signals`. Helper: `apps/api/src/lib/validate.ts`; good pattern in `auth.ts`. |
| FA-03 | AI JSON parsed, not schema-validated | `openai.ts` returns raw strings; `parseJson()` + inline types then persisted in `apps/worker/src/worker.ts` (Lead / OutreachDraft / Lead+ScoringOutcome) and `processors.ts` `sendCampaignBatch` (OutreachDraft). `zod` already a backend-core dep; no output schemas exist. |
| FA-04 | Dev deps in API/worker images | `Dockerfile.api` & `Dockerfile.worker` run `npm ci --include=dev`, single-stage. `Dockerfile.web` is correctly multi-stage. |
| FA-05 | `/metrics` open when token unset | `apps/api/src/server.ts` — auth enforced only if `METRICS_TOKEN` set. |
| FA-06 | Rate-limit falls back to in-process | `apps/api/src/middleware/rateLimit.ts` — per-process Map on Redis failure. |
| FA-07 | `vercel.json` uses `npm install` | `vercel.json` `"installCommand": "npm install"`. |
| FA-08 | Healthcheck not readiness | `apps/api/railway.toml` → `/api/health`; no worker railway healthcheck (worker runs a health server: `startHealthServer`, `WORKER_HEALTH_PORT` 9090). `/api/live`,`/api/ready`,`/api/health` all exist. |

## Reusable primitives (build on these)
- **Circuit breaker** `packages/backend-core/src/lib/circuit.ts` (`CircuitBreaker`, `CircuitOpenError`, per-provider singletons).
- **Config/env** `config.ts` (`isProduction`, `validateConfig`, `getReadinessReport`), `env.ts` (`requireEnv`, `hasEnv`).
- **Observability** `observability.ts` `captureError`; structured `logger.ts`; worker `lib/metrics.ts` (`incJob`, `observeJobDuration`).
- **Validation** `apps/api/src/lib/validate.ts` + `workspaceIdField`; request schemas in `packages/shared`.
- **Timeout exemplars** to mirror: `openai.ts`, `mail.ts`.
- **Scheduled-job pattern** for cleanup jobs: the repeatable `auto-imap-sync` scheduler in `apps/worker/src/worker.ts`.

## Tickets

### P0 — Reliability / safety blockers
- **T1 · Shared provider HTTP client (FA-01).** New `packages/backend-core/src/lib/providerHttp.ts` (`providerFetch(url, init, { provider, timeoutMs?, retries?, maxBytes?, envPrefix?, breaker? })`): clearable `unref`'d abort timeout (default 12s), retry only transient (408/425/429/5xx/network) with backoff + `Retry-After`, response-size bound, optional circuit breaker, structured logging of provider/status/latency/attempts; throws a normalized `ProviderHttpError` on timeout/network/oversize. Timeout & retry are env-configurable (`${envPrefix}_TIMEOUT_MS`/`_RETRIES` → `EXTERNAL_HTTP_TIMEOUT_MS`/`_RETRIES` → default), and a caller-supplied `AbortSignal` is propagated. Route the provider calls in `prospectSources.ts` (Apollo search, Google Places), `services/apollo.ts`, `services/hunter.ts` (find + verify) through it. **(implemented on this branch — PR #111)**
- **T2 · Strict AI-output schemas (FA-03).** New `packages/backend-core/src/schemas/aiOutputs.ts` (zod `.strict()` + length caps); validate inside `openai.ts` (single choke point); update worker/processors/`ai.ts` callers; invalid output → controlled job failure + telemetry + "needs human review" fallback.
- **T3 · Route-validation coverage (FA-02).** Add zod + `validate()` to every mutation endpoint missing it (full gaps: `leads`, `billing`, `outcomes`, `ingest`, `ai`; partials elsewhere); bounded pagination/query schemas; export DTOs from schemas; CI guard failing on an unvalidated mutation route. Execute per-router.

### P1 — Deployment hardening
- **T4 · Multi-stage runtime images (FA-04)** for `Dockerfile.api`/`Dockerfile.worker` (`npm ci --omit=dev` runtime stage); CI image smoke test + scan.
- **T5 · Protect `/metrics` (FA-05)** — fail boot in production if metrics enabled without `METRICS_TOKEN`/private binding.
- **T6 · Lockfile installs (FA-07)** — `vercel.json` → `npm ci`.
- **T7 · Readiness healthcheck (FA-08)** — `railway.toml` → `/api/ready`; add worker healthcheck config.
- **T8 · Rate-limit degradation (FA-06)** — fail-closed/stricter local limit for auth/reset/ingest/import/AI endpoints on Redis loss; alert on fallback.

### P2 — Operational scale & polish
- Provider cost/quota weighting; scheduled cleanup jobs (expired tokens, old processed events); dashboards/alerts; frontend polish (stale `useApi.ts` comment, Nginx CSP `connect-src`, generated client types); runbook refresh.

## External hardening waves — T2/T3 source material
Four externally-produced patches are preserved verbatim under
`docs/analysis/external-hardening/` (`wave1`…`wave4-hardening.patch`). Together
they implement T2, effectively all of T3, and a typed frontend/backend contract
layer. They are the reference to **adapt** (not `git apply` — cut against a
pre-#110 snapshot, editing the old `apps/api/src/services/{apollo,hunter}.ts`
locations, so they conflict with #110/#111). Waves build on each other: apply in
order 1→4 when porting.

- **Wave 1** — FA-03 (T2): strict zod schemas + `parseLeadResearchJson` /
  `parseOutreachJson` / `parseReplyAnalysisJson` in `openai.ts`, fail-closed with
  `ApiError(502)`, wired into worker/processors/prospects/`eval-outreach`. Also
  zod validation for `routes/ai.ts`. (Its FA-01 `externalHttp.ts`/`fetchWithTimeout`
  is **superseded by our `providerFetch`** — discard; its env-knob + parent-signal
  ideas were folded into `providerFetch`.)
- **Wave 2** — FA-02 (T3, part 1): `validate()` + zod across `billing`,
  `campaigns`, `leads` (7 routes), `mailbox`, `prospects` (POST/PATCH/outcome +
  tightened `discover`), `workspaces` (6 routes), plus `validate.ts`
  `idField`/bounded `workspaceIdField` and shared-type conformance asserts.
- **Wave 3** — FA-02 (T3, part 2 — the long tail): `validate.ts` helpers
  (`formatZodError`, `parseBody`, `parseQuery`, `validateQuery`, `optionalIdField`,
  `positiveIntFromQuery`); validation for `jobs` (queue/jobId params + schemas;
  also fixes bulk-research `leadId` sourcing), `signals` (query + body, enum
  types, bounded evidence), `outcomes` (fixes `Boolean("false")===true`
  mis-record), `ingest` (batch body + email syntax + key-rotation query), `packs`,
  `auth` (profile + paired password change), and `prospects`
  `import`/`import-signals`/intent bodies. New tests in
  `routes-{ingest,outcomes,signals,prospects}`.

With waves 2 + 3, T3 route validation spans **effectively every mutation route**.
- **Wave 4** — typed API contracts (the "kill frontend/backend drift" part of
  T3): a route-keyed body registry in `@acaos/shared` (`ApiBodyByRoute`,
  `ApiBody<Route>`), an `apps/web/src/lib/apiContract.ts` `jsonBody('<METHOD>
  <ROUTE>', body)` helper, web mutation calls migrated to it, backend
  `Assert<Extends<…>>` conformance guards beside the zod schemas, and a
  `scripts/check-api-contracts.mjs` (+ `npm run check:api-contracts`) guard that
  fails when production web code uses raw `JSON.stringify` for an API body.

**Residual TODO** (not in any wave): the backend CI guard that fails on an
*unvalidated mutation route* (distinct from wave 4's frontend-body guard), query
validation on remaining read routes, and an OpenAPI export from the shared
registry + zod schemas.

**Decision (2026-06-19):** port T2 + T3 from these waves **after #110 + #111
merge** to master, adapting to the relocated backend-core files and avoiding the
`prospects.ts` conflict with #110.

## Sequencing
1. Merge the enrichment work (PR #110) — T1 builds on its relocated provider files.
2. **T1 → T2 → T3** (P0), each with tests.
3. P1 batch (T4–T8) — small, independent, parallelizable.
4. P2 as a follow-up sprint.

## Verification
`npm run typecheck`, `npm run check:boundaries`, `npm test` (+ new unit tests) per ticket; full release gate (report §14): `npm ci`, boundaries, typecheck, coverage, test:db, test:redis, build, e2e, docker builds, staging smoke tests.
