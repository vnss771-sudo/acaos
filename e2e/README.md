# End-to-end smoke tests (Playwright)

These tests boot the **real** API + web servers and drive the actual browser UI.
Their purpose is to catch frontend↔backend **contract** regressions that the unit
suites structurally cannot: the API route tests construct request bodies
themselves, so a frontend that omits a required field still passes them. Two such
bugs shipped despite 935 green tests (AI Tools omitted `workspaceId`; campaign
launch omitted `approved`) — these specs would have failed on both.

## What's covered

| Spec | Flow | Guards against |
|---|---|---|
| `onboarding-seed.spec.ts` | signup → wizard → playbook → ICP → seed → Prospects | onboarding/seed pipeline producing visible data |
| `ai-tools-run.spec.ts` | AI Tools "Run" (sync, default) | request must include `workspaceId` (was `400 workspaceId required`) |
| `campaign-launch.spec.ts` | Launch → Approve & Send (approvalMode on) | request must include `approved: true` (was `403 Approval required`) |

The AI and campaign specs assert on the actual outgoing request via
`waitForResponse`, so they verify the exact contract rather than a side effect.

## Requirements

- **Postgres** and **Redis** reachable. Defaults match the repo's integration
  tests: `postgresql://postgres:postgres@127.0.0.1:5432/acaos_test` and
  `redis://127.0.0.1:6379`. Override with `E2E_DATABASE_URL` / `E2E_REDIS_URL`.
- The Chromium build Playwright drives. One-time:

```bash
npm run test:e2e:install   # downloads Chromium (needs egress to the Playwright CDN)
```

The worker is **not** started — every assertion is on a synchronous response
(seed and AI run inline; campaign launch asserts the 202 enqueue ack).

## Run

```bash
# Postgres + Redis must be up first.
npm run test:e2e
```

Playwright starts the API (:4000) and web (:5173) servers automatically and,
locally, reuses them if already running. `global-setup` applies migrations.

In CI the `verify-e2e` job (see `.github/workflows/ci.yml`) provides the
services and installs the browser.
