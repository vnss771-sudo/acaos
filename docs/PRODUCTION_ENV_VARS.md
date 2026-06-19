# Production Environment Variables

## Core
- DATABASE_URL
- REDIS_URL
- JWT_SECRET
- WEB_URL
- VITE_API_BASE_URL

## OpenAI
- OPENAI_API_KEY
- OPENAI_MODEL

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

## Data Retention
The worker periodically purges aged data. The per-class `*_DAYS` windows override the defaults documented in `docs/DATA_RETENTION.md`. All optional.
- RETENTION_PURGE_INTERVAL_MS — how often the worker runs the purge job, in ms. Default 86400000 (24h). Required: no.
- RETENTION_PROCESSED_EMAIL_DAYS — retention window for processed inbound emails (days). Default 90. Required: no.
- RETENTION_OUTREACH_SENT_DAYS — retention window for sent outreach records (days). Default 548 (~18mo). Required: no.
- RETENTION_DISCOVERY_RUN_DAYS — retention window for discovery run history (days). Default 365. Required: no.
- RETENTION_AUDIT_EVENT_DAYS — retention window for audit events (days). Default 730 (~24mo). Required: no.
- RETENTION_STRIPE_EVENT_DAYS — retention window for stored Stripe events (days). Default 365. Required: no.
- RETENTION_AUTH_TOKEN_DAYS — retention window for expired/revoked auth tokens (days). Default 30. Required: no.
