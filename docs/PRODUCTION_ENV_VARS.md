# Production Environment Variables

## Core
- DATABASE_URL
- REDIS_URL
- JWT_SECRET
- WEB_URL
- VITE_API_BASE_URL

## OpenAI
- OPENAI_API_KEY
- OPENAI_MODEL — must be allow-listed (defaults to `gpt-4o-mini`); an unrecognized value falls back to the default rather than running up spend.
- OPENAI_MODEL_ALLOWLIST — optional comma-separated extra models to permit for `OPENAI_MODEL` (e.g. when adopting a newer model).

## Stripe
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_STARTER
- STRIPE_PRICE_GROWTH

## Email
- SMTP_HOST
- SMTP_PORT
- SMTP_SECURE
- SMTP_USER
- SMTP_PASS
- SMTP_FROM

## Mailbox Sync
- IMAP_HOST
- IMAP_PORT
- IMAP_USER
- IMAP_PASS
- IMAP_SECURE

## Security / Step-up
- STEP_UP_MAX_AGE_MIN — step-up re-auth freshness window (minutes) for sensitive mutations (billing, admin promotion, MFA disable). Default 15. Required: no.
- TENANT_GUARD_MODE — `off` | `observe` | `enforce`. Default `off` (the cross-tenant query backstop is inert). Set `observe` in production to log any workspace-scoping miss with zero behavior change, then graduate to `enforce` once the observe window is clean. Strongly recommended `observe` at minimum for a multi-tenant deployment.

## Launch Controls & Feature Flags
All read live from the environment — flipping any of these takes effect on the next request/job with **no restart or deploy**. See `packages/backend-core/src/lib/launchControls.ts`.

### Blast-radius kill switches (default ON — operators opt OUT)
- FEATURE_AI — AI features (research, outreach generation, reply analysis). Default `true`.
- FEATURE_SEND — outbound email sending. Default `true`.
- FEATURE_MAILBOX_SYNC — IMAP mailbox sync (reply/bounce ingest). Default `true`.
- FEATURE_DISCOVERY — prospect discovery. Default `true`.

### Safe launch (default OFF — conservative controlled rollout)
- SAFE_LAUNCH_MODE — forces human approval of every outbound draft and clamps every workspace's daily send cap to a low ceiling. Default `false`.
- SAFE_LAUNCH_DAILY_SEND_CAP — the clamped daily ceiling applied to all workspaces while SAFE_LAUNCH_MODE is on. Default 20.

### Automatic follow-ups (opt-IN — default OFF)
- FOLLOWUPS_ENABLED — master switch for the automatic multi-step follow-up sender. Default `false`. On top of this, each campaign must set `autoFollowupsEnabled`. Both must be true before any follow-up is dispatched.
- FOLLOWUP_SCAN_INTERVAL_MS — how often the worker scans for due follow-up tasks. Default 60000 (1 min).

### Sender-reputation circuit breaker
- REPUTATION_GUARD_MODE — `off` | `observe` | `enforce`. Default `observe` (computes and logs a degraded reputation but does NOT block; graduate to `enforce` once observed numbers look right).
- REPUTATION_WINDOW_DAYS — trailing window for the bounce/complaint rate. Default 7.
- REPUTATION_MIN_SENDS — minimum sends in the window before the guard can trip (avoids acting on noise). Default 50.
- REPUTATION_MAX_BOUNCE_RATE — bounce-rate threshold (0–1). Default 0.05 (5%).
- REPUTATION_MAX_COMPLAINT_RATE — complaint-rate threshold (0–1). Default 0.003 (0.3%).

### Domain warmup (opt-IN per workspace via `WorkspaceICP.warmupStartedAt`)
- WARMUP_SCHEDULE — comma-separated per-day caps for the ramp. Default `20,40,80,150,300,500,750,1000`. With no `warmupStartedAt` set on a workspace, warmup is a no-op.

### Send pacing & caps
- PER_DOMAIN_DAILY_CAP — max sends to a single recipient domain per UTC day. Unset/0 = disabled (default). Opt-in.
- STALE_SENDING_RECOVERY_MINUTES — age after which a stuck `SENDING` outbox row is reclaimed as FAILED by the maintenance sweep (frees the cap). Default 120.
  (Per-workspace daily/monthly caps and quiet-hours send windows live on `WorkspaceICP`: `dailySendLimit`, `monthlySendLimit`, `sendWindowStartHour`/`sendWindowEndHour`/`sendTimezone`/`sendWeekdaysOnly`.)

### Abuse prevention
- BLOCK_DISPOSABLE_EMAILS — reject signups from known throwaway email providers. Default `true`. Set `false` to disable.
- DISPOSABLE_EMAIL_DOMAINS — comma-separated extra domains to treat as disposable, merged with the built-in list.

### AI governance
- REPLY_CLASSIFICATION_MIN_CONFIDENCE — minimum confidence (0–100) below which a `NOT_INTERESTED` reply is NOT acted on as an irreversible DEAD transition (downgraded to human review). Default 60. Set 0 to always act on the label.
- SOFT_BOUNCE_SUPPRESS_THRESHOLD — number of repeated soft bounces before an address is suppressed (hard/unknown bounces suppress immediately). Default 3.
- OPENAI_MAX_TOKENS_RESEARCH / OPENAI_MAX_TOKENS_OUTREACH / OPENAI_MAX_TOKENS_REPLY — per-task output-token ceilings. Defaults 1500 / 1200 / 700. A hard ceiling of 4000 is enforced so a fat-fingered override can't request a runaway completion.
- WORKSPACE_AI_RATE_MAX — per-workspace AI requests allowed per hour at the HTTP edge (complements the per-IP `aiRateLimit` and the monthly plan meter; stops one workspace bursting the shared OpenAI key across rotating IPs). Default 120; set 0 to disable.
- AI_COST_CENTS_RESEARCH / AI_COST_CENTS_OUTREACH / AI_COST_CENTS_REPLY — estimated USD cents per AI call, used only for the cost-per-lead / AI-spend reporting in billing usage (never gates anything). Defaults 0.1 / 0.08 / 0.05 (gpt-4o-mini token profiles); tune for other model tiers.

## Observability
- METRICS_TOKEN — bearer token guarding `/metrics` (API + worker). Required in production; when unset, `/metrics` is disabled and a startup warning is logged.
- LOG_LEVEL — `debug` | `info` | `warn` | `error`. Default `info`.
- SENTRY_DSN — error-reporting transport. Optional, but **set it in production**: `@sentry/node` is bundled, so a DSN turns on error capture (without it, `captureError` is a silent no-op).
- STATS_RECONCILE_ENABLED — `true` to enable the periodic `CampaignDailyStats` ↔ `ContactEvent` reconciliation sweep that repairs projection drift. Default off; recommended `true` in production.
- WORKER_HEALTH_PORT — port for the worker's `/live` `/ready` `/metrics` server. Default 9090 (or platform `$PORT`).

## Data Retention
The worker periodically purges aged data and reclaims stale `SENDING` rows. The per-class `*_DAYS` windows override the defaults documented in `docs/DATA_RETENTION.md`. All optional.
- RETENTION_PURGE_INTERVAL_MS — how often the worker runs the purge + stale-send recovery job, in ms. Default 86400000 (24h). Required: no.
- RETENTION_PROCESSED_EMAIL_DAYS — retention window for processed inbound emails (days). Default 90. Required: no.
- RETENTION_OUTREACH_SENT_DAYS — retention window for sent outreach records (days). Default 548 (~18mo). Required: no.
- RETENTION_DISCOVERY_RUN_DAYS — retention window for discovery run history (days). Default 365. Required: no.
- RETENTION_AUDIT_EVENT_DAYS — retention window for audit events (days). Default 730 (~24mo). Required: no.
- RETENTION_STRIPE_EVENT_DAYS — retention window for stored Stripe events (days). Default 365. Required: no.
- RETENTION_AUTH_TOKEN_DAYS — retention window for expired/revoked auth tokens (days). Default 30. Required: no.
