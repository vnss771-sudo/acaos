# Go-Live Checklist

The single operator checklist for shipping an ACAOS release to production. It
stitches together the deeper docs rather than duplicating them — follow the links
for detail. Work top to bottom; don't skip the sign-off.

> Deep references: [DEPLOYMENT](./DEPLOYMENT.md) ·
> [DEPLOY_RUNBOOK](./DEPLOY_RUNBOOK.md) · [PRODUCTION_ENV_VARS](./PRODUCTION_ENV_VARS.md) ·
> [MIGRATIONS](./MIGRATIONS.md) · [SMOKE_TESTS](./SMOKE_TESTS.md) ·
> [OPERATIONS](./OPERATIONS.md) · [RUNBOOKS](./RUNBOOKS.md) ·
> [KEY_ROTATION](./KEY_ROTATION.md) · [SLO](./SLO.md) · [GITHUB_ADMIN](./GITHUB_ADMIN.md)

---

## 0. Pre-flight (code is ready)

- [ ] `master` is green: all 17 CI checks pass on the release commit.
- [ ] `npm run verify` is clean locally (lint, typecheck, unit + DB + Redis tiers).
- [ ] `dist-pack/release-manifest.json` regenerated (`node scripts/make-zips.mjs`);
      record the `releaseId` — it is the immutable deployment contract.
- [ ] No pending DB migration drift: CI's schema-drift check passed for this commit.
- [ ] CHANGELOG / release notes updated for user-facing changes.

## 1. Secrets & environment

Set every required var per [PRODUCTION_ENV_VARS](./PRODUCTION_ENV_VARS.md). The app
**fails fast** without these — generate with `openssl rand -hex 32`, never reuse
the compose placeholders:

- [ ] `DATABASE_URL` (Postgres 14+)
- [ ] `REDIS_URL` (Redis 6+ — required for the worker / queues)
- [ ] `JWT_SECRET`
- [ ] `EMAIL_ENCRYPTION_KEY` (64 hex chars; keyring versioned — see [KEY_ROTATION](./KEY_ROTATION.md))
- [ ] `TRUST_PROXY` matches the actual proxy depth (default `1`; too broad lets clients spoof `X-Forwarded-For` and dodge rate limits)
- [ ] `OPENAI_API_KEY` (AI research / outreach / **reply classification**)
- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- [ ] SMTP: `SMTP_HOST/USER/PASS/FROM` (sending)
- [ ] **IMAP: `IMAP_HOST/USER/PASS`** — required for the reply pipeline that feeds the **Inbox** (or set per-workspace in `WorkspaceEmailConfig`)
- [ ] `METRICS_TOKEN` (bearer for `/metrics`; in prod `/metrics` 404s without it)
- [ ] Web build arg `VITE_API_BASE_URL=https://api.<domain>`

## 2. Infrastructure

- [ ] PostgreSQL provisioned, reachable from `api` + `worker`, automated backups on.
- [ ] Redis provisioned, reachable from `api` + `worker`.
- [ ] DNS for web + api; TLS certs valid.
- [ ] Email deliverability: SPF + DKIM records published (use `GET /api/mailbox/check-domain`).
- [ ] Container images built + Trivy-scanned by CI (`Dockerfile.api|worker|web`).

## 3. Deploy (order matters)

The **api** image is the **only** migration writer (`scripts/start-with-migrations.mjs`
runs `prisma migrate deploy`, then the API). See [MIGRATIONS](./MIGRATIONS.md).

1. [ ] Deploy/upgrade Postgres + Redis.
2. [ ] Deploy **api** → it applies pending migrations (latest:
       `20260621170000_outreach_reply_metadata`). Confirm it logs migrations applied.
3. [ ] Deploy **worker** (never runs migrations; consumes `analyze-reply`,
       `sync-mailbox`, `send-campaign`, etc.).
4. [ ] Deploy **web** (nginx static, port 8080) built against the prod API URL.
5. [ ] Point Stripe webhooks at the production `/api/billing/webhook`.

## 4. Post-deploy verification

Health:
- [ ] `GET /api/live` → 200 with the expected `releaseId`.
- [ ] `GET /api/ready/strict` → 200 (db + redis up).
- [ ] Worker health endpoint green.

Core smoke (full list in [SMOKE_TESTS](./SMOKE_TESTS.md)):
- [ ] Signup → login → `/api/auth/me`.
- [ ] Create workspace; create a lead/prospect.
- [ ] AI research + outreach generation return content.
- [ ] Stripe checkout creates a session; webhook verifies a CLI test event.
- [ ] SMTP sends a test email; `POST /api/mailbox/sync` ingests a reply.

This release's surfaces:
- [ ] **Acquisition Radar** loads with the Next Best Action hero.
- [ ] **⌘K command palette** opens (⌘K / Ctrl+K / `/`) and routes.
- [ ] **Review Queue** shows risk flags on a draft; batch approve/reject works.
- [ ] **Prospects** grid sorts + bulk-select rescore/recommend work.
- [ ] **Inbox** lists a classified reply (run a `sync-mailbox` against a seeded reply);
      classification + suggested action render.
- [ ] **Investor demo** (`?demo=investor`) renders the seeded shell, **Exit demo** clears it.

## 5. Rollback

- [ ] Redeploy the previous `releaseId` images (api → worker → web).
- [ ] Migrations are additive/nullable this release, so a code rollback needs **no
      down-migration**; the new `OutreachSent.reply*` columns are simply unused by older code.
- [ ] If a forward migration must be reverted, follow [MIGRATIONS](./MIGRATIONS.md) — never `db push` in prod.

## 6. Operator-only GitHub items (cannot be automated by CI/agent)

- [ ] Dismiss the known `apiKeys` CodeQL false-positive in the Security tab.
- [ ] Re-enable `master` branch protection (required checks on; approvals = 0 for the solo-maintainer flow) — see [GITHUB_ADMIN](./GITHUB_ADMIN.md).

## 7. Sign-off

- [ ] On-call owner assigned; alerting + dashboards live (see [SLO](./SLO.md)).
- [ ] `releaseId` recorded in the deploy log.
- [ ] Stakeholders notified.
