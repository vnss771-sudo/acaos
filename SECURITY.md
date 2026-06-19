# Security

This document describes ACAOS's security posture and how to report a
vulnerability. It reflects controls that are implemented and tested in the
codebase, plus the operational hardening expected at deploy time.

## Reporting a vulnerability

Please report security issues privately — **do not** open a public GitHub issue.
Email the maintainers (see repository owner) with steps to reproduce and impact.
We aim to acknowledge within 3 business days and to ship a fix or mitigation for
confirmed high-severity issues promptly. Please allow reasonable time for a fix
before any public disclosure.

## Trust boundaries

- **Tenant isolation.** Every workspace-scoped API requires the caller to be a
  member of that workspace (`userBelongsToWorkspace` / `userHasWorkspaceAccess`).
  Billing management additionally requires an owner/admin role; the cross-tenant
  admin panel requires a platform admin (`ADMIN_EMAIL`). Multi-tenant isolation is
  covered by a dedicated test suite (`tests/multi-tenancy-stress.test.ts`).
- **Ingest API** authenticates via a per-workspace hashed API key (`x-api-key`),
  resolved to a workspace before any write.
- **Webhooks.** The Stripe webhook verifies the signature
  (`stripe.webhooks.constructEvent`) against `STRIPE_WEBHOOK_SECRET` before acting.

## Authentication & sessions

- Passwords hashed with **bcrypt**; email verification + password-reset tokens are
  single-use and expiring.
- Access tokens are short-lived **JWTs**; `JWT_SECRET` is validated at startup
  (length + not-a-placeholder) and required in production.
- Refresh tokens live in an **httpOnly** cookie (`SameSite` + `Secure`
  configurable), hashed at rest. Refresh/rotate is protected by a **CSRF header**
  check layered on top of the SameSite attribute.

## Application hardening

- **Security headers** on every response (`X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `COOP`, a locked-down CSP, and HSTS
  in production) — see `middleware/securityHeaders.ts`.
- **Rate limiting** (Redis-backed, in-process fallback): a strict limiter on auth
  routes (anti-brute-force) and a general limiter on the API.
- **Input validation** via zod schemas pinned to the shared typed contracts, so
  request shape can't silently drift from what the client sends.
- **No SQL injection surface:** all database access goes through Prisma; the few
  raw statements use parameterized tagged templates (no `*Unsafe`, no string
  concatenation). Verified by audit.
- **No mass assignment:** handlers select explicit fields rather than spreading
  request bodies into the ORM.
- **Plan/abuse limits:** AI calls, discovery runs, and lead counts are metered per
  workspace with atomic, advisory-locked checks (429 on exceed) — preventing a
  single tenant from exhausting platform-level provider keys.

## Secrets & data at rest

- Per-workspace SMTP/IMAP credentials are encrypted with **AES-256-GCM**
  (`EMAIL_ENCRYPTION_KEY`); the key is required and validated at startup.
- No secrets are logged. The error-reporting transport (Sentry, optional) receives
  exceptions + request context (method/route/id), not request bodies or tokens.
- The Prometheus `/metrics` endpoint can be locked behind `METRICS_TOKEN`.

## Operational responsibilities (deploy time)

These are environment concerns the code can't enforce on its own:

- Set strong, unique `JWT_SECRET`, `EMAIL_ENCRYPTION_KEY`, and all provider keys;
  rotate on suspected compromise.
- Terminate TLS at the edge (HSTS is emitted in production).
- Restrict `/metrics` exposure (private network and/or `METRICS_TOKEN`).
- Keep dependencies patched (run `npm audit` in CI/CD).
- Configure database backups and least-privilege DB credentials.

See [`docs/HARDENING_NOTES.md`](docs/HARDENING_NOTES.md) and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for related detail.

## Security evidence & runbooks

- [`docs/SECURITY_ASVS_MATRIX.md`](docs/SECURITY_ASVS_MATRIX.md) — OWASP ASVS
  control mapping (control → code → test), with status and tracked gaps.
- [`docs/KEY_ROTATION.md`](docs/KEY_ROTATION.md) — rotation cadence and exact
  procedure for every secret (including the `EMAIL_ENCRYPTION_KEY` re-encryption
  caveat and self-service ingest-key rotation).
- [`docs/DATA_RETENTION.md`](docs/DATA_RETENTION.md) — retention windows per data
  class, plus tenant export and deletion.
