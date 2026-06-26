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
| `TENANT_GUARD_MODE` | `off` | api, worker | `off` \| `observe` (log unscoped queries) \| `enforce` (throw). Defense-in-depth over the per-query `workspaceId` filters. |
| `FOLLOWUPS_ENABLED` | `false` | worker | Master switch for multi-step follow-up sending (opt-in dormant). |
| `FOLLOWUP_SCAN_INTERVAL_MS` | `60000` | worker | Due-follow-up scan cadence. |
| `FEATURE_SEND` / `FEATURE_AI` / … | on | api, worker | Per-capability kill-switches (`isFeatureEnabled`). |
| `RATE_LIMIT_DISABLED` | `false` | api | 🧪 Tests/load runs only — **never** in production. |

---

## 3. Sender reputation & deliverability

| Var | Default | Scope | Notes |
|---|---|---|---|
| `REPUTATION_GUARD_MODE` | `''` (off) | worker | `observe` (warn) \| `enforce` (block sends) on bounce/complaint thresholds. |
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
| `OPENAI_MODEL` | `gpt-4o-mini` | worker | Generation model. |
| `OPENAI_MODEL_ALLOWLIST` | `''` | worker | Comma-separated allowlist; empty = allow the configured model. |
| `OPENAI_TIMEOUT_MS` | `30000` | worker | Per-call request timeout. |
| `OPENAI_MAX_TOKENS_RESEARCH` / `_OUTREACH` / `_REPLY` | per-task (capped at 4000) | worker | Output-token ceilings per task. |
| `AI_COST_CENTS_RESEARCH` / `_OUTREACH` / `_REPLY` | `0.1` / `0.08` / `0.05` | worker | Cents-per-call estimates for the `acaos_ai_cost_cents_total` metric. |
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
- `style-src-attr 'unsafe-inline'` is allowed because the app uses React inline
  styles; migrating those to CSS classes lets you drop the inline-style allowance.

---

## 8. Tooling / CI / test only (not runtime app config)

These are read by scripts, smoke tests, load tests, and CI — never by the running
app. Set per-invocation, not in deployment config: `DEPLOY_*`, `SMOKE_*`,
`LOADTEST_*`, `EXPECT_*`, `AUTH_TOKEN`, `WORKSPACE_ID`, `ACAOS_SKIP_PRISMA_POSTINSTALL`,
`HOSTNAME` (set by the platform, surfaced as the Sentry `server_name`).

---

*Keep this in sync when adding a `process.env` read: a new runtime variable should
land here (and in `.env.example` if it's core/required) in the same change.*
