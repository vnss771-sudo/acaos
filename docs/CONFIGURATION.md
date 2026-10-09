# Runtime configuration reference

Every runtime environment variable ACAOS reads, with its default, scope, and
whether production requires it. `.env.example` holds the **core connection/secret**
vars you must set to boot; this file is the **complete** reference, including the
operational toggles and tuning knobs that ship with safe defaults.

Conventions: **Scope** = which process reads it (api / worker / web build / shared).
**Prod?** = ✅ required in production, ⚙️ optional tuning (safe default), 🧪 tooling/test
only. Booleans are `true`/`false` (string) unless noted.

---

## 1. Core — required to boot (see `.env.example`)

| Var | Default | Scope | Prod? | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | — | api, worker | ✅ | Postgres connection string. |
| `DIRECT_URL` | `DATABASE_URL` | migrations | ⚙️ | Set when `DATABASE_URL` points at PgBouncer so migrations bypass the pooler. |
| `REDIS_URL` | — | api, worker | ✅ | BullMQ + rate-limit + cache + circuit-breaker store. |
| `JWT_SECRET` | random (dev only) | api | ✅ | Boot **fails** in production if unset/weak. No `change-me` fallback. |
| `JWT_EXPIRES_IN` | `15m` | api | ⚙️ | Access-token TTL. Keep short. |
| `REFRESH_TOKEN_DAYS` | `30` | api | ⚙️ | Refresh-token lifetime. |
| `EMAIL_ENCRYPTION_KEYS` / `EMAIL_ENCRYPTION_ACTIVE_KEY_ID` | — | api, worker | ✅ | AES-256-GCM keyring for SMTP/IMAP/TOTP secrets at rest. (`EMAIL_ENCRYPTION_KEY` is the legacy single-key form.) Fail-closed outside dev/test. |
| `WEB_URL` / `ALLOWED_ORIGINS` | — | api | ✅ | Exact CORS origin allowlist (`ALLOWED_ORIGINS` comma-separated wins; provider wildcards are **not** honored). |
| `NODE_ENV` | `development` | all | ✅ | `production` enables HSTS, opaque errors, fail-closed encryption, the degraded rate-limit tightening, etc. |
| `PORT` / `WORKER_HEALTH_PORT` | `3000` / `9090` | api / worker | ⚙️ | HTTP + health/metrics ports. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` `SMTP_SECURE` | — | worker | ✅* | Platform SMTP fallback; per-workspace config overrides. Required to send. |
| `IMAP_*` | — | worker | ⚙️ | Platform IMAP for reply ingestion (per-workspace overrides). |
| `OPENAI_API_KEY` | — | worker | ✅* | Required for AI research/outreach/reply features. |
| `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET` `STRIPE_PRICE_*` | — | api | ✅* | Required for billing. |
| `APOLLO_API_KEY` `GOOGLE_PLACES_API_KEY` `HUNTER_API_KEY` | — | worker | ⚙️ | Discovery providers (features degrade gracefully if unset). |
| `OPPORTUNITY_DISCOVERY_ENABLED` / `OPPORTUNITY_DISCOVERY_INTERVAL_MS` | `false` / 6h | worker, api | ⚙️ | Work discovery ("Find work") sweep. Opt-in; min interval 15 min. |
| `COMMERCIAL_OPPORTUNITIES_ENABLED` | `true` | worker | ⚙️ | Opportunity engine reassessment on each prospect rescore. Local only, never sends; `false` is a kill switch. See `docs/ACQUISITION_OS_FOUNDATION.md`. |
| `PLANNINGALERTS_API_KEY` | — | worker | ⚙️ | Enables the council development-application source. Commercial use needs a paid PlanningAlerts plan. AusTender needs no key. |
| `METRICS_TOKEN` | — | api, worker | ⚙️ | Bearer that protects `/metrics`. Set in production. |
| `ADMIN_EMAIL` | — | api | ⚙️ | One-time, audited, step-up-gated platform-admin bootstrap (not a perpetual backdoor). |

\* required only if you use that capability (sending / AI / billing).

---

## 2. Launch controls & safety gates

Blast-radius controls — flip without a deploy. Most ship **off/dormant** so the
platform starts conservative.

| Var | Default | Scope | Notes |
|---|---|---|---|
| `SAFE_LAUNCH_MODE` | `false` | api, worker | Forces approval mode on and clamps every workspace's daily send to `SAFE_LAUNCH_DAILY_SEND_CAP`, regardless of workspace settings. |
| `SAFE_LAUNCH_DAILY_SEND_CAP` | `20` | api, worker | The clamp applied while safe-launch is on. |
| `ENFORCE_SEND_READINESS` | on (off only in `development`/`test`) | api | Gate sends on SMTP + CAN-SPAM sender identity. Fails **closed** for staging/preview; `false`/`0` disables. |
| `COMPLIANCE_GATE_ENABLED` | `false` | api | Require lawful-basis / CASL consent before sending (ships dormant until legal copy is signed). |
| `TENANT_GUARD_MODE` | `observe` in production, `off` elsewhere | api, worker | `off` \| `observe` (log unscoped queries) \| `enforce` (throw). Defense-in-depth over the per-query `workspaceId` filters. |
| `FOLLOWUPS_ENABLED` | `false` | worker | Master switch for multi-step follow-up sending (opt-in dormant). |
| `FOLLOWUP_SCAN_INTERVAL_MS` | `60000` | worker | Due-follow-up scan cadence. |
| `FEATURE_SEND` / `FEATURE_AI` / … | on | api, worker | Per-capability kill-switches (`isFeatureEnabled`). |
| `RATE_LIMIT_DISABLED` | `false` | api | 🧪 Tests/load runs only — **never** in production. |

---

## 3. Sender reputation & deliverability

| Var | Default | Scope | Notes |
|---|---|---|---|
| `REPUTATION_GUARD_MODE` | `observe` | worker | `off` \| `observe` (warn) \| `enforce` (block sends) on bounce/complaint thresholds. |
| `REPUTATION_MAX_BOUNCE_RATE` | `0.05` | worker | Trailing bounce-rate ceiling. |
| `REPUTATION_MAX_COMPLAINT_RATE` | `0.003` | worker | Trailing complaint-rate ceiling. |
| `REPUTATION_MIN_SENDS` | `50` | worker | Minimum sends in-window before the guard evaluates a workspace. |
| `REPUTATION_WINDOW_DAYS` | `7` | worker | Trailing window for the rates. |
| `PER_DOMAIN_DAILY_CAP` | unset (off) | worker | Opt-in per-recipient-domain daily cap (advisory pacing). |
| `WARMUP_SCHEDULE` | `20,40,80,150,300,500,750,1000` | worker | Per-day warmup caps (comma-separated) for opt-in warming workspaces. |
| `SOFT_BOUNCE_SUPPRESS_THRESHOLD` | (code default) | worker | Consecutive soft bounces before suppressing a recipient. |
| `STALE_SENDING_RECOVERY_MINUTES` | `120` | worker | Age after which a stuck `SENDING` row is reclaimed → `FAILED`. |

---

## 4. AI / OpenAI

| Var | Default | Scope | Notes |
|---|---|---|---|
| `OPENAI_BASE_URL` | SDK default | api, worker | Optional OpenAI-compatible endpoint override; also accepts `OPENAI_API_BASE`. |
| `OPENAI_MODEL` | `gpt-5-mini` | api, worker | Generation model; unknown values fall back to the default. |
| `OPENAI_MODEL_ALLOWLIST` | `''` | api, worker | Comma-separated additional models to allow; the default safe model list remains enabled. |
| `OPENAI_SHADOW_MODEL` | `''` | api, worker | Allow-listed model that receives a copy of sampled requests for comparison. Its output is always discarded; only model ids, latency, success and output hashes are logged (`ai.shadow_comparison`). |
| `OPENAI_SHADOW_SAMPLE_RATE` | `0` | api, worker | Share of requests shadowed, 0–1 (deterministic per request). Off by default: each shadowed request is a second, billed provider call. |
| `OPENAI_FALLBACK_MODEL` | `''` | api, worker | Recorded in the model registry only. There is no automatic fail-over; promote by changing `OPENAI_MODEL`, roll back by changing it back. |
| `OPENAI_TIMEOUT_MS` | `30000` | api, worker | Per-call request timeout. |
| `OPENAI_MAX_TOKENS_RESEARCH` / `_OUTREACH` / `_REPLY` | per-task (capped at 4000) | api, worker | Completion-token ceilings per task; GPT-5/reasoning families use `max_completion_tokens`. |
| `AI_COST_CENTS_RESEARCH` / `_OUTREACH` / `_REPLY` | `0.32` / `0.25` / `0.22` | api, worker | Rough GPT-5-mini cents-per-call estimates for the `acaos_ai_cost_cents_total` metric; tune for actual model usage. |
| `REPLY_CLASSIFICATION_MIN_CONFIDENCE` | (code default) | worker | Min confidence before a NOT_INTERESTED reply auto-kills a lead. |
| `WORKSPACE_AI_RATE_MAX` | (code default) | api | Per-workspace AI request rate ceiling. |

---

## 5. Observability & error reporting

| Var | Default | Scope | Notes |
|---|---|---|---|
| `SENTRY_DSN` | unset (no-op) | api, worker | Enables the zero-dependency Sentry HTTP transport. |
| `SENTRY_RATE_PER_MIN` | `30` | api, worker | Outbound error-report rate (token-bucket refill). |
| `SENTRY_BURST` | `10` | api, worker | Burst allowance before throttling. |
| `SENTRY_DEDUP_MS` | `5000` | api, worker | Window collapsing identical errors to one report. |
| `METRICS_DOMAIN_CACHE_MS` | `30000` | worker | TTL of the cached `/metrics` domain snapshot (decouples DB cost from scrape cadence). |
| `LOG_LEVEL` | `info` | all | Structured-log level. |
| `WORKER_REJECTION_THRESHOLD` / `WORKER_REJECTION_WINDOW_MS` | (code defaults) | worker | Unhandled-rejection-storm restart guard. |
| `STATS_RECONCILE_ENABLED` / `STATS_RECONCILE_WINDOW_DAYS` | on / (default) | worker | Campaign-stats projection ↔ ledger reconciliation sweep. |
| `STATS_CACHE_TTL_MS` | (default) | api | Per-workspace stats-endpoint cache TTL. |

---

## 6. Data retention (daily purge; see `docs/DATA_RETENTION.md`)

| Var | Default (days) | Class |
|---|---|---|
| `RETENTION_PROCESSED_EMAIL_DAYS` | 90 | ProcessedEmail |
| `RETENTION_OUTREACH_SENT_DAYS` | 548 | OutreachSent |
| `RETENTION_DISCOVERY_RUN_DAYS` | 365 | DiscoveryRun |
| `RETENTION_AUDIT_EVENT_DAYS` | 730 | AuditEvent |
| `RETENTION_ANALYTICS_EVENT_DAYS` | 365 | AnalyticsEvent |
| `RETENTION_STRIPE_EVENT_DAYS` | 365 | ProcessedStripeEvent |
| `RETENTION_AUTH_TOKEN_DAYS` | 30 | spent auth tokens |
| `RETENTION_PURGE_INTERVAL_MS` | 86400000 | purge cadence |

---

## 7. Security & networking

| Var | Default | Scope | Notes |
|---|---|---|---|
| `TRUST_PROXY` | off | api | How many proxy hops to trust for client IP (rate-limit correctness behind a load balancer). |
| `COOKIE_SECURE` | `true` in prod | api | `false` only for local HTTP dev; production boot warns/blocks insecure combos. |
| `COOKIE_SAMESITE` | `lax` | api | Refresh-cookie SameSite. |
| `STEP_UP_MAX_AGE_MIN` | (default) | api | Freshness window for step-up re-auth on sensitive mutations. |
| `BLOCK_DISPOSABLE_EMAILS` | off | api | Reject signups from disposable-email domains. |
| `DISPOSABLE_EMAIL_DOMAINS` | built-in list | api | Extra disposable domains to block. |

### Frontend CSP (`nginx.conf`)
The web image ships a strict CSP. Two production hardening notes:
- `connect-src 'self' https:` is intentionally broad so the SPA can reach any HTTPS
  API origin out of the box. **Tighten it to your exact API origin** in production
  (e.g. `connect-src 'self' https://api.example.com`) to narrow exfiltration paths.
- There is no `'unsafe-inline'` anywhere: `style-src-elem 'self'` and
  `style-src-attr 'none'`. React `style={{}}` props still work because the client
  renderer applies them through the CSSOM (`element.style`), which CSP does not
  govern. What CSP blocks — raw `style=""` attributes via `setAttribute`,
  `cssText`, `innerHTML`, injected `<style>` elements — is rejected by
  `npm run check:csp`, and `e2e/csp-strict.spec.ts` drives every hub of the
  production build under this exact header and fails on any CSP violation.

---

## 8. Tooling / CI / test only (not runtime app config)

These are read by scripts, smoke tests, load tests, and CI — never by the running
app. Set per-invocation, not in deployment config: `DEPLOY_*`, `SMOKE_*`,
`LOADTEST_*`, `EXPECT_*`, `AUTH_TOKEN`, `WORKSPACE_ID`, `ACAOS_SKIP_PRISMA_POSTINSTALL`,
`HOSTNAME` (set by the platform, surfaced as the Sentry `server_name`).

---

*Keep this in sync when adding a `process.env` read: a new runtime variable should
land here (and in `.env.example` if it's core/required) in the same change.*


### OpenAI model compatibility
Model compatibility is centralized in `packages/backend-core/src/lib/modelProfiles.ts`. Reasoning families use `max_completion_tokens` and do not receive `temperature`; standard chat models retain `max_tokens` plus the configured sampling temperature. Run `npm run smoke:ai-provider` with production-like credentials before promoting a model change.

## Passkeys / WebAuthn (foundation; not enabled yet)

ACAOS now includes the persistent credential/challenge schema and relying-party configuration contract for WebAuthn. The cryptographic ceremony endpoints remain intentionally disabled until the vetted SimpleWebAuthn server/browser packages are installed and locked in `package-lock.json` under the Node 26 toolchain.

When that implementation is activated, the required configuration will be:

- `WEBAUTHN_ENABLED=true`
- `WEBAUTHN_RP_ID=<registrable relying-party domain>`
- `WEBAUTHN_ORIGIN=https://<exact application origin>` (falls back to `APP_URL`)
- `WEBAUTHN_RP_NAME=ACAOS` (optional display name)
- `WEBAUTHN_CHALLENGE_TTL_MS=300000` (optional; minimum one minute)

ACAOS rejects non-HTTPS WebAuthn origins outside localhost and requires the origin hostname to equal the RP ID or be its subdomain. Do not enable `WEBAUTHN_ENABLED` until the ceremony verifier is present.
