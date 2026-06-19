# Secret & Key Rotation Runbook

Every secret ACAOS uses, why it matters, the blast radius if it leaks, and the
exact rotation procedure. Rotate on a schedule (below) and immediately on any
suspected exposure. All secrets are supplied as environment variables (see
`docs/PRODUCTION_ENV_VARS.md`); none are committed to the repo.

## Rotation schedule

| Secret | Routine cadence | Rotate immediately if… |
|---|---|---|
| `JWT_SECRET` | 90 days | a token-signing leak is suspected |
| `EMAIL_ENCRYPTION_KEY` | See special procedure | leaked — but read the re-encryption note first |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | 180 days | a Stripe key is exposed |
| `OPENAI_API_KEY` | 180 days | unexpected usage/billing |
| `APOLLO_API_KEY`, `HUNTER_API_KEY`, `GOOGLE_PLACES_API_KEY` | 180 days | quota anomalies or exposure |
| `SMTP_PASS`, `IMAP_PASS` | 90 days | mailbox compromise |
| `METRICS_TOKEN` | 180 days | scrape endpoint exposed |
| `SENTRY_DSN` | as needed | project moved/leaked |
| Per-workspace ingest API keys | self-service, owner-driven | a workspace key is exposed |

## Procedures

### `JWT_SECRET`
Signs access/refresh tokens. Rotating invalidates all existing access tokens;
refresh tokens are validated against the `RefreshToken` table, so sessions
re-mint cleanly on the next refresh.
1. Set the new `JWT_SECRET` in the environment.
2. Roll the API (and worker if it verifies tokens).
3. Clients silently re-authenticate via the refresh cookie. To force full
   re-login, also revoke refresh tokens (truncate/expire `RefreshToken`).

### `EMAIL_ENCRYPTION_KEY` (special — read first)
Encrypts stored SMTP/IMAP credentials in `WorkspaceEmailConfig`. **Rotating the
key without re-encrypting makes existing stored credentials undecryptable.**
1. Decrypt existing configs with the old key and re-encrypt with the new key in a
   one-off migration, **or**
2. Clear stored credentials and require workspaces to re-enter them.
Never rotate this key in place without one of the above.

### Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
1. Create a new restricted secret key in the Stripe dashboard; deploy it.
2. Roll the webhook signing secret; update `STRIPE_WEBHOOK_SECRET` and redeploy.
   Signature verification (`apps/api/src/routes/billing.ts`) rejects events signed
   with the old secret, so deploy the env change and the Stripe-side change close
   together.
3. Revoke the old key once traffic is confirmed healthy.

### Provider keys (`OPENAI_API_KEY`, `APOLLO_API_KEY`, `HUNTER_API_KEY`, `GOOGLE_PLACES_API_KEY`)
1. Mint the replacement key in the provider console.
2. Deploy the new value; confirm `provider_calls_total{outcome="success"}` for that
   provider keeps incrementing (see `/metrics`).
3. Revoke the old key.

### Mailbox (`SMTP_PASS`, `IMAP_PASS`)
1. Rotate the password / app-password at the mail provider.
2. Update the env (platform default) and/or the affected `WorkspaceEmailConfig`.
3. Verify with `POST /api/mailbox/send-test` and an IMAP sync.

### Per-workspace ingest API keys
Self-service and owner-only — no env change:
- Rotate: `POST /api/ingest/keys/rotate?workspaceId=…` (returns the new raw key
  once; the old hash is evicted from cache so it can't be replayed).
- Revoke: `DELETE /api/ingest/keys?workspaceId=…`.

## After any rotation
- Confirm `/api/ready` is green and error rates are normal.
- Record the rotation (date, secret, operator) in your ops log / `AuditEvent`
  where applicable.
- If the rotation was due to a suspected leak, also review access logs and
  revoke active sessions (`RefreshToken`).
