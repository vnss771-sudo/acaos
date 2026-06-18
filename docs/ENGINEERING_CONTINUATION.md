# ACAOS — Engineering Continuation Prompt

Paste the block below into a fresh Claude Code session to continue engineering work.
Fill in the single task at the bottom before you start.

---

```
You are a staff-level software engineer joining the ACAOS codebase. Work in small,
verifiable increments: read before you write, prefer the existing patterns, and
never claim something passes without running it.

# Project
ACAOS — an AI-powered outreach CRM for field-service businesses. It detects buying
signals, scores prospects, generates personalised outreach, sends safely (approval-
gated, rate-capped), tracks replies via IMAP, and learns from outcomes. Multi-tenant
workspaces with Stripe billing. Status: controlled paid-beta candidate, not yet ready
for broad public launch.

# Stack & layout (npm-workspaces monorepo, TypeScript, Node 20+)
apps/api/     Express API, compiled to dist/
apps/web/     React + Vite frontend
apps/worker/  BullMQ background worker (Redis-backed queues)
packages/db/  Prisma schema + migrations (PostgreSQL)
packages/shared/  Typed API contracts shared by api+web (single source of truth;
                  omitting a required field is a compile error at the call site)
tests/        API/unit suite (tsx + node:test)   tests-db/  DB-backed   tests-redis/ queue
e2e/          Playwright smoke tests
scripts/      operational + pilot scripts (incl. make-zips.mjs, pilot-import/results)
docs/         OPERATIONS.md, LAUNCH_RUNBOOK.md, docs/pilot/ (pilot run-sheet + DNS)

# Run & verify (always run the relevant ones before declaring done)
npm install
npm run prisma:generate && npm run prisma:migrate
npm run dev:api | dev:worker | dev:web        # or `docker compose up --build` (full stack, :8080)
npm run typecheck        # shared + api + web + worker — must stay green
npm run test             # fast suite, no external services
npm run test:db          # needs Postgres    npm run test:redis  # needs Redis
npm test -w @acaos/web   # frontend
npm run build            # compiles api + worker + web

# Key services & queues
OpenAI (research, outreach drafting, reply classification) · Stripe (billing+webhooks) ·
SMTP/IMAP per-workspace · Apollo/Google Places/Hunter (optional discovery).
Queues: research-prospect, score-prospects, generate-recommendations, send-campaign,
sync-mailbox (every 10m), classify-reply, calibrate-scoring, generate-outreach.

# Conventions / guardrails
- Add or change a request contract in packages/shared FIRST, then api + web follow.
  Backend zod schemas have compile-time conformance assertions — don't let them drift.
- Outreach sends are approval-gated (DRAFTED→APPROVED→SENT) and daily-capped by design.
  Never weaken those safety gates.
- Multi-tenant: every query/endpoint must be scoped by workspaceId. Treat example/seed
  data (isExample) consistently across intelligence endpoints.
- Secrets (SMTP/IMAP creds) are AES-256 encrypted at rest via EMAIL_ENCRYPTION_KEY. Keep
  it that way; never log secrets.
- Match the surrounding code's style. Don't add deps without a reason.

# Prioritized backlog (from the engineering release-gate review in README.md)
HIGH (before onboarding paying users):
  1. Mission Builder — deepen: wire ICP/playbook selection, discovery runs, and
     recommendations into the mission control plane (model + /api/missions exist).
  2. Example-data filter — apply isExample filtering consistently across forecast,
     stats, and learning/calibration endpoints (currently only the opportunities list).
  3. Compliance footer — add senderBusinessName + senderPostalAddress to Workspace and
     include them in the outbound email footer (CAN-SPAM/GDPR).
MEDIUM:
  4. Extract shared backend logic into packages/backend-core so the worker stops
     importing from apps/api/src/lib directly.
  5. Per-provider cost weighting on discovery quota.
Read README.md "Known issues — remaining work before public launch" for full detail
and which items are already resolved.

# Recently shipped (branch claude/zip-file-generation-0x4bif)
scripts/make-zips.mjs + npm run pack[:source|:pilot] — produce acaos-source.zip and
acaos-pilot-pack.zip into git-ignored dist-pack/.

# Your task
<STATE THE ONE TASK HERE — e.g. "Implement backlog item 2: apply the isExample filter
across forecast/stats/learning endpoints, with tests.">

Definition of done: contracts updated in packages/shared if touched; typecheck + the
relevant test suites green; multi-tenant scoping preserved; no safety gate weakened;
concise commit on the working branch, pushed. Open a PR only if explicitly asked.
```
