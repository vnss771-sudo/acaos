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

- [ ] `master` is green: every CI check passes on the release commit, including the
      `required` roll-up and CodeQL.
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
- [ ] *Optional, mailbox sign-in* (see [MAILBOX_SIGN_IN](./MAILBOX_SIGN_IN.md)):
      `GOOGLE_OAUTH_CLIENT_ID/SECRET` and/or `MICROSOFT_OAUTH_CLIENT_ID/SECRET`
      (+ `MICROSOFT_OAUTH_TENANT`, default `common`), with `API_URL=https://api.<domain>`
      so the redirect URI resolves. Register that redirect URI with each provider.
      `MICROSOFT_SEND_VIA_GRAPH` (default `true`) sends Microsoft 365 mail through Graph.

## 2. Infrastructure

- [ ] PostgreSQL provisioned, reachable from `api` + `worker`. **Automated snapshots + PITR
      on; a restore drill has been run and the RTO recorded** — see [RECOVERY](./RECOVERY.md)
      (not just a checkbox: an untested backup is not a backup).
- [ ] Redis provisioned, reachable from `api` + `worker`. AOF recommended (see RECOVERY.md).
- [ ] DNS for web + api; TLS certs valid.
- [ ] Email deliverability: SPF + DKIM records published (use `GET /api/mailbox/check-domain`).
- [ ] Container images built + Trivy-scanned by CI (`Dockerfile.api|worker|web`).
- [ ] **Observability live, not placeholder:** `ops/monitoring/prometheus.yml` blackbox/probe
      targets point at the real `https://api.<domain>` / `https://app.<domain>` (the committed
      `example.com` values are templates); alert routes configured. `SENTRY_DSN` set (else
      error capture is a silent no-op). `METRICS_TOKEN` set (else `/metrics` 404s).
- [ ] **Operational launch controls reviewed** (all optional, safe defaults — see
      [PRODUCTION_ENV_VARS](./PRODUCTION_ENV_VARS.md)): `TENANT_GUARD_MODE=observe`,
      `STATS_RECONCILE_ENABLED=true`; consider `SAFE_LAUNCH_MODE=true` for the supervised pilot.

## 2b. Compliance (optional — the gate ships dormant)

The in-product compliance surface (lawful basis, terms, sub-processors, CASL consent) is
built but **disabled by default**. To enforce it before/at launch:

- [ ] Counsel has reviewed & approved the drafts in [`docs/legal/`](./legal/README.md)
      (acceptable-use, DPA, LIA template) and the sub-processor wording.
- [ ] `SUBPROCESSORS_VERSION` / `COMPLIANCE_TERMS_VERSION` match the approved copy.
- [ ] Decide rollout (new workspaces vs all); communicate to existing customers.
- [ ] Set `COMPLIANCE_GATE_ENABLED=true` — `getSendReadiness` then requires a recorded lawful
      basis + accepted terms (+ CASL consent for Canada-targeting) before a workspace can send.

Leaving the gate off is fine for a supervised pilot; the posture/consent data still records.

## 3. Deploy (order matters)

The **api** image is the **only** migration writer (`scripts/start-with-migrations.mjs`
runs `prisma migrate deploy`, then the API). See [MIGRATIONS](./MIGRATIONS.md).

1. [ ] Deploy/upgrade Postgres + Redis.
2. [ ] Deploy **api** → it applies pending migrations. Confirm it logs them applied and
       that the newest one matches the newest folder in `packages/db/prisma/migrations/`
       (`ls packages/db/prisma/migrations | sort | tail -2`; at the time of writing
       `20261003300000_reply_feedback`).
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

The contractor loop (the core product — walk it end to end on a fresh workspace):
- [ ] **Today** loads as the landing screen.
- [ ] **Work → Find work** shows matched tenders / development applications;
      **Pursue** → **Record quote** → **Client accepted** moves a card to the Won tab.
- [ ] **Start the job** creates the job and its site in one click.
- [ ] **Crew → Crew / Shifts / Roster**: add a crew member with a rate and log hours
      against the job's site.
- [ ] **Work → Jobs & margins**: close out the job and see quoted vs delivered margin.

Mail and the rest of the app:
- [ ] **Settings → mailbox**: *Sign in with Google / Microsoft* connects a mailbox (if
      the OAuth keys are set); a test send from a Microsoft 365 mailbox goes through.
- [ ] **Inbox** lists a classified reply (run a `sync-mailbox` against a seeded reply);
      classification + suggested action render; correcting a label (👎) updates the
      classification-accuracy panel.
- [ ] **Review Queue** shows risk flags on a draft; batch approve/reject works. A draft
      containing a card number or secret key is held for review and can't be approved.
- [ ] **⌘K command palette** opens (⌘K / Ctrl+K / `/`) and routes.
- [ ] **Investor demo** (`?demo=investor`) renders the seeded shell, **Exit demo** clears it.

## 5. Rollback

- [ ] Redeploy the previous `releaseId` images (api → worker → web).
- [ ] Check the migrations shipped since the previous release. If they only add tables,
      nullable columns or columns with defaults (true of every migration up to
      `20261003300000_reply_feedback`), a code rollback needs **no down-migration**: older
      code simply ignores the new columns.
- [ ] If a forward migration must be reverted, follow [MIGRATIONS](./MIGRATIONS.md) — never `db push` in prod.

## 6. Operator-only GitHub items (cannot be automated by CI/agent)

- [ ] Dismiss the known `apiKeys` CodeQL false-positive in the Security tab.
- [ ] Re-enable `master` branch protection (required checks on; approvals = 0 for the solo-maintainer flow) — see [GITHUB_ADMIN](./GITHUB_ADMIN.md).

## 7. Sign-off

- [ ] On-call owner assigned; alerting + dashboards live (see [SLO](./SLO.md)).
- [ ] `releaseId` recorded in the deploy log.
- [ ] Stakeholders notified.
