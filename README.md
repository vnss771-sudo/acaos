# ACAOS — Agentic Client Acquisition OS

A multi-tenant B2B sales intelligence platform. Detects buying-window signals, scores prospects, generates AI-drafted outreach, tracks replies, and learns from outcomes.

## What is functional

- **Signal engine** — 20+ signal types (job postings, news mentions, tech adoption, PROBLEM_OWNER_ACTIVATION, etc.) with time-decay scoring and ICP-aware weighting
- **Prospect scoring** — opportunity score, fit/intent/timing/confidence breakdown, FPF classifier, ACT/WATCH/IGNORE tiers
- **Opportunity Briefs** — AI-generated dossiers: why now, likely problem, problem owner role, offer angle, outreach approach
- **15 BullMQ worker queues** — research-lead, generate-outreach, analyze-reply, sync-mailbox, score-prospects, generate-recommendations, calibrate-scoring, generate-strategy-cards, advance-cadence, harvest-signals, re-engage, generate-opportunity-brief, retrain-signal-weights, maintenance, daily-brief
- **Cadence engine** — multi-step outreach sequences with scheduling, suppression checks, and reply-driven stage transitions
- **Reply analysis** — INTERESTED / NOT_INTERESTED / OUT_OF_OFFICE / UNSUBSCRIBE classification; auto-advances prospect stages and triggers booking-link sends
- **Stripe billing** — checkout sessions, subscription lifecycle (updated/deleted/past_due), webhook signature verification
- **IMAP mailbox sync** — inbound reply matching via imapflow
- **Email suppression** — workspace-scoped suppression list checked before every outbound send (cadence, direct, booking-link)
- **Learning loop** — signal-combination performance tracking; calibrate-scoring retrains weights from outcomes
- **Daily brief** — per-workspace HOT-prospect digest emailed to workspace owner at 07:00 UTC
- **Multi-tenant workspace model** — role-based membership (owner/admin/member), all routes workspace-scoped
- **HMAC-signed tracking URLs** — open/click pixel injection with TRACKING_SECRET distinct from JWT_SECRET
- **Structured logging** — Pino JSON logs throughout API and worker

## Known limits (pre-live-deploy)

- End-to-end runtime (Postgres + Redis + SMTP/IMAP + Stripe webhook round-trip) not yet verified in a live hosted environment
- Prisma client generation requires network access to binaries.prisma.sh during `npm run prisma:generate`
- Signal scoring constants (decay curves, ICP weights) are informed priors — they become accurate after real outcome data flows through the learning loop
- Deliverability is an operational concern, not a code concern: cold email from a fresh domain requires domain warm-up, SPF/DKIM/DMARC, and a reputable sending IP

## Environment variables

All required unless marked optional.

### Core infrastructure
| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`) |
| `REDIS_URL` | Redis connection string (`redis://host:6379`) |
| `JWT_SECRET` | Secret for signing auth tokens — ≥32 chars |
| `TRACKING_SECRET` | HMAC secret for tracking URLs — must differ from JWT_SECRET |

### AI
| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | Model ID (default: `gpt-4o-mini`) |

### Email (SMTP outbound)
| Variable | Description |
|---|---|
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (default: 587) |
| `SMTP_USER` | SMTP login username |
| `SMTP_PASS` | SMTP login password |
| `SMTP_FROM` | Sender address, e.g. `ACAOS <noreply@yourdomain.com>` |

### Email (IMAP inbound — reply matching)
| Variable | Description |
|---|---|
| `IMAP_HOST` | IMAP server hostname |
| `IMAP_USER` | IMAP login username |
| `IMAP_PASS` | IMAP login password |

### App URLs
| Variable | Description |
|---|---|
| `APP_URL` | Public API base URL — used for tracking pixel injection |
| `WEB_URL` | Public frontend URL — CORS allowlist + email links |
| `ALLOWED_ORIGINS` | Comma-separated additional CORS origins (optional) |

### Signal harvesting (optional — skipped when absent)
| Variable | Description |
|---|---|
| `APOLLO_API_KEY` | Apollo.io API key for job-posting signals |
| `SERPER_API_KEY` | Serper.dev API key for news-mention signals |

### Payments (optional)
| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_STARTER` | Stripe price ID for starter plan |
| `STRIPE_PRICE_GROWTH` | Stripe price ID for growth plan |

### Tuning (optional — all have sane defaults)
| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_AUTH_MAX` | 10 | Auth attempts per 15 min per IP |
| `RATE_LIMIT_GENERAL_MAX` | 200 | General requests per min per IP |
| `RATE_LIMIT_AI_MAX` | 60 | AI requests per hour per IP |
| `RATE_LIMIT_MAIL_MAX` | 5 | Test email sends per hour per IP |
| `RATE_LIMIT_OUTREACH_MAX` | 10 | Direct outreach sends per hour per IP |
| `BULL_BOARD_USER` | — | Basic auth username for `/api/queues` dashboard |
| `BULL_BOARD_PASS` | — | Basic auth password for `/api/queues` dashboard |

## Deployment checklist

Before first deploy and after any schema change:

```bash
npx prisma generate --schema packages/db/prisma/schema.prisma
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
npm run typecheck
npm test
```

The API's `start` script (`tsx src/server.ts`) does not run migrations. Migrations run in the Render/Railway `releaseCommand` only.

## Local setup

### Option A: local processes
1. Copy `.env.example` to `.env` and fill values
2. `npm install`
3. `npm run prisma:generate && npm run prisma:migrate`
4. `npm run dev:api` (port 4000)
5. `npm run dev:worker`
6. `npm run dev:web` (port 5173)

### Option B: Docker Compose
```bash
docker compose -f docker-compose.local.yml up --build
```
Web: http://localhost:5173 · API: http://localhost:4000

## Handy commands

| Command | What it does |
|---|---|
| `npm test` | 556 chaos + unit tests |
| `npm run typecheck` | tsc across api + web + worker |
| `npm run smoke:api` | Starts API and hits `/api/health` |
| `npm run build` | Production web bundle |
| `npm audit` | Dependency vulnerability scan |
