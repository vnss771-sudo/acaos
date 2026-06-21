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
Encrypts stored SMTP/IMAP credentials in `WorkspaceEmailConfig` **and** MFA TOTP
secrets (`User.totpSecret`), both with AES-256-GCM. **Overwriting the key in place
without re-encrypting makes existing stored values undecryptable** — it breaks both
stored mailbox credentials *and* stored TOTP secrets (affected users would have to
re-enroll MFA). Do not swap `EMAIL_ENCRYPTION_KEY` for a different value in place.

#### Preferred: non-destructive versioned rotation
The encryption helper supports a **keyring** so the old and new keys are both live
during a rotation, letting you re-encrypt data gradually with zero downtime and no
forced MFA re-enrollment. Blobs are tagged with their key version (`k<id>:iv:tag:ct`);
untagged `iv:tag:ct` blobs are "legacy" and decrypt with `EMAIL_ENCRYPTION_KEY`.

Environment:
- `EMAIL_ENCRYPTION_KEY` — the legacy/default key. Keep it set while *any* legacy
  (untagged) blobs remain; it still decrypts them.
- `EMAIL_ENCRYPTION_KEYS` — comma-separated `id:hex` keyring, e.g.
  `2:<64hex>,1:<64hex>`. Holds every key that must remain readable.
- `EMAIL_ENCRYPTION_ACTIVE_KEY_ID` — the keyring id used to seal **new** writes.

Procedure:
1. Generate a new 32-byte key (`openssl rand -hex 32`); add it to the keyring with a
   fresh id, e.g. `EMAIL_ENCRYPTION_KEYS=2:<newhex>`, and set
   `EMAIL_ENCRYPTION_ACTIVE_KEY_ID=2`. Leave `EMAIL_ENCRYPTION_KEY` in place. Deploy.
   New writes are now sealed under key `2`; all existing data still decrypts.
2. Run a one-off migration that walks the encrypted columns and calls
   `rewrapSecret(blob)` for every row where `needsReencryption(blob)` is true
   (decrypt under the old key, re-encrypt under the active key). Idempotent and safe
   to re-run.
3. Once nothing reports `needsReencryption`, you may drop the retired key from
   `EMAIL_ENCRYPTION_KEYS` (and stop relying on `EMAIL_ENCRYPTION_KEY` for reads if
   all data is now versioned).

#### Fallback (destructive)
If you cannot run a migration, either clear stored credentials (require workspaces
to re-enter them) and reset affected users' MFA (require re-enrollment), **or**
accept the breakage. Prefer the versioned rotation above.

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
