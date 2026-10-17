# ACAOS Copilot — Repository Audit and Implementation Plan

Status: **design only, for review.** No production code, migration or deploy is changed by this document.
Audited: branch tip `ca15cd3` (PR #420, quote card). Method: file reads and greps of the paths cited below.

**Not verified from the repo** (needs a staging or Railway check before Phase 2): whether migration
`20261018000000_quote_estimate` (latest of 116) is applied on staging or production; which features are live in
production versus merged to `master`; mailbox-sync and billing-route internals beyond the entitlement and quota code
read here; real provider spend.

## Answer to the final question

**Smallest safe pilot release ("Copilot Lite"):** a read-only, stateless, page-aware help panel plus a deterministic,
role-aware setup checklist, for owners/admins and field workers only.

- About 35–40 curated articles, shipped **inside the deployed build** so the docs cannot out-run the code.
- In-process keyword retrieval, with no DB table, no embeddings and no migration.
- One new model call per question through the existing OpenAI path, in JSON mode.
- Validated output: citations and `routeId` are checked against server-side registries.
- A separate Copilot meter and kill switch.
- A **no-LLM fallback** (article search plus checklist). It is also the first thing shipped, so the pilot has value even if the model path is gated.

**Reuse:** `services/openai.ts` (breaker, model allowlist, token policy), `lib/aiSchemas.ts`, `lib/sensitiveData.ts`,
the injection-fencing pattern, `lib/permissions.ts`, `userBelongsToWorkspace`, `workspaceRateLimit`, `createRateLimiter`,
`lib/limits.ts` plus the `UsageRecord` table, `launchControls`, `lib/audit.ts`, `trackEvent`, web `router.ts` / `hubs.ts` /
`settingsSections.ts`, the `Drawer` / `useFocusTrap` / `useMediaQuery` UI pieces, the typed `RouteContracts` client, and
the `eval/` + `tests/` infrastructure.

**Genuinely new:** the knowledge catalogue, a server-side route registry (promoted from the web), the onboarding-step
registry, the Copilot orchestrator, the panel UI, the eval dataset.

## Deliverable A — Current-state audit

| Area | Exists (path) | Capability | Limitation relevant to Copilot |
|---|---|---|---|
| AI provider | `packages/backend-core/src/services/openai.ts` (`chat()`, `model()`, `chatRequest`) | OpenAI chat completions, JSON mode, `openAiBreaker`, active/shadow/fallback model registry, `OPENAI_MODEL_ALLOWLIST`, token clamp (`tokenLimitOptions`), call observer (tokens, latency) | `chat()` is **not exported**; only task-specific wrappers (`generateOutreach` etc.) exist. Provider is **OpenAI** (default `gpt-5-mini`), not Anthropic. No per-call timeout or retry config is exposed beyond the client defaults. |
| Model controls | `lib/modelRegistry.ts`, `lib/modelProfiles.ts`, `lib/providerClient.ts`, `lib/circuit.ts`, `tests-redis/breaker-store.test.ts` | Allowlist is the cost boundary; breaker state shared via Redis; `callProvider` classifies provider errors | Breaker maps to HTTP 503 "AI service temporarily unavailable" (reusable as the fallback trigger). |
| Prompt safety | `openai.ts` (`sanitizeUntrusted`, `UNTRUSTED_DATA_SYSTEM_RULE`, `buildBusinessContextBlock`), `lib/sensitiveData.ts` (`redactSensitiveData`: card, secret key, password, TFN), `lib/aiSchemas.ts` (`parseAiJson`, `AiSchemaError`) | Structural fencing (not phrase-matching), input redaction, zod validation of model JSON | Fence markers are prospect-specific (`<prospect_data>`); need a generic fence helper. |
| AI routes | `apps/api/src/routes/ai.ts`, mounted `server.ts:207` | Pattern to copy exactly: `requireAuth` → `requireVerifiedEmail` → `requireFeature('ai')` → `aiRateLimit` → `validate` → `userBelongsToWorkspace` → `enforceWorkspaceAiRate` → `checkAndIncrementAiUsage` → generate → `refundAiUsage` on failure | `workspaceId` arrives in the body or query (verified server-side by membership, which is the existing convention). |
| Quotas and spend | `lib/limits.ts` (`PLAN_LIMITS`, `assertAiUsageAllowed`, `spendCeilingCents`), `lib/aiCost.ts`, `UsageRecord` (`action` is a free `String`, unique on workspace+month+action) | Monthly call cap (free 15, starter 300, growth ∞) **and** a dollar ceiling (free $5, starter $50, growth $500); advisory-lock check-then-increment; refund on failure | `UsageAction` is a closed union, and every `AI_*` action shares one pool. Copilot in that pool would burn a free workspace's 15 outreach calls in a few questions. It needs its own meter (see C). |
| Rate limits | `middleware/rateLimit.ts` (`aiRateLimit` 60/h/IP, Redis with in-process fallback and degraded mode), `lib/workspaceRateLimit.ts` (`enforceWorkspaceAiRate`) | Per-IP and per-workspace | Same bucket as the other AI tools unless a new named limiter is added. |
| Auth and tenancy | `middleware/auth.ts`, `lib/workspaces.ts`, `middleware/tenantContext.ts`, `tenantResource.ts`, `lib/tenantGuard.ts`, `docs/TENANT_RESOURCE_MATRIX.md` | JWT auth, membership check, AsyncLocalStorage tenant guard (observe or enforce) | Guard is opt-in by env mode. |
| RBAC | `lib/permissions.ts` (`Permission`, `roleCan`, `assertWorkspacePermission`); `WorkspaceRole = owner\|admin\|member` in `packages/shared` | Single capability matrix; `member` holds no named capability | There is **no `technician` role**. A technician is a `member` linked to a crew record (web `hooks/useFieldWorkerMode.ts`, `lib/hubs.ts` `FIELD_WORKER_VIEWS`). Need to confirm the server-side derivation of that link before relying on it. All quote and delivery endpoints require `ops:manage` (admin+). |
| Feature flags | `lib/launchControls.ts` (`Feature = ai\|send\|mailboxSync\|discovery\|enquiries`, env-driven), `middleware/featureGate.ts`; web `VITE_HUB_NAV` plus a localStorage override (`hubs.ts`) | Global kill switches that the worker also honours | **No per-workspace feature flags.** A pilot allowlist does not exist. |
| Entitlements | `lib/billingEntitlements.ts` (`none/active/grace/lapsed`), `limits.ts` plan catalog | Plan and billing state | Used only for gating, not for describing features. |
| Onboarding | `App.tsx:523` (renders `OnboardingWizard` when `!onboardingCompleted && canManage`), `components/OnboardingWizard.tsx` (659 lines), `ContractorSetup.tsx` (discovery profile), `GettingStarted.tsx` + `apps/api/src/lib/sendReadiness.ts` (`getSendReadiness`, deterministic checks, deep-links via `settingsSections.ts`), `Workspace.onboardingCompleted` (`routes/workspaces/core.ts:289`), `lib/analytics.ts` (`ACTIVATION_STAGES`, `trackEvent`) | Deterministic facts already exist: workspace fields, `WorkspaceEmailConfig`, discovery profile, crew, quotes, jobs | Three separate partial mechanisms; the checklist is **send-outreach centric**, not contractor-first. No step registry. No persisted "skipped". |
| Quoting | `Quote` model (`estimate` JSON), `lib/quoteEstimate.ts` (`computeEstimate`, `crewRateSummary`, `QUOTE_ESTIMATE_VERSION`), `routes/delivery.ts`, `lib/jobEconomics.ts` | Pure, deterministic calculation: the explainer can describe the formula from code-derived text | Quote values are admin-only data; Copilot must receive none of them. |
| Navigation | web `lib/router.ts` (`VIEW_PATHS`, `viewForPath`), `lib/hubs.ts` (tabs, `adminOnly`), `lib/settingsSections.ts`, `CommandPalette.tsx` | A complete route table plus role gating hints | Lives **only in `apps/web`**; the server cannot validate against it today. |
| Audit/observability | `lib/audit.ts` (`recordAudit`, `recordCriticalAudit`), `AuditEvent` (24 mo), `middleware/metrics.ts`, `lib/logger.ts`, `setAiProviderCallObserver` | Append-only audit, Prometheus metrics, token/latency hook | Tokens are observed but not persisted per workspace (`eval/README.md`: "no cost recorded"). |
| Retention | `docs/DATA_RETENTION.md`, `lib/retention.ts`, daily purge | "Prompts and raw model inputs/outputs are not persisted" — an existing, documented posture | A stateless Copilot fits this unchanged. |
| Docs/help | `docs/*.md` (≈45 files: runbooks, design, plans); `components/settings/BusinessContextSection.tsx` | Operator/engineering docs only | **No customer help content, no in-app help, no help centre.** |
| Eval/test infra | `eval/` (versioned manifests v1, v2; offline plus live), `scripts/eval-offline.mjs`, `.github/workflows/eval.yml` (weekly, live), `tests/` (node:test + tsx), `tests-db/`, `tests-redis/`, `tests/security-adversarial.test.ts`, `e2e/` Playwright (phone-width quote-builder test exists), `scripts/check-*.mjs` ratchets (`check-frontend-mutations`, `check-boundaries`, `check-critical-test-coverage`) | Pattern for dataset versioning, offline determinism, boundary ratchets | Datasets are outreach/research/graph; none for support. |
| Frontend primitives | `components/ui/Drawer.tsx`, `hooks/useFocusTrap`, `useEscapeKey`, `useMediaQuery`, `Toast`, `ErrorBanner`, `EmptyState`, `lib/routeApi.ts` + `RouteContracts` in `packages/shared/src/index.ts` | Accessible overlay primitives and a typed client | Mutation ratchet requires routing through the typed client (add 4 contracts). |

## Deliverable B — Gap analysis

| Requirement | Class |
|---|---|
| Auth, workspace scoping, RBAC, verified email | **Implemented** (copy the `ai.ts` pipeline) |
| Rate limits, spend cap, refund-on-failure | **Reuse with modification** (new named limiter; new meter excluded from the shared outreach pool) |
| Model allowlist, breaker, token limits, observer | **Reuse with modification** (export one generic JSON entry point) |
| Injection fencing, redaction, output validation | **Reuse with modification** (generic fence; `CopilotResponseSchema`) |
| Kill switch | **Reuse with modification** (`Feature` gains `copilot`) |
| Per-workspace pilot allowlist | **New** (small env allowlist, no schema) |
| Knowledge catalogue plus retrieval | **New** (content is the long pole) |
| Server route registry (routes, min role, feature) | **New**, extracted from web `router.ts`/`hubs.ts` into `packages/shared` |
| Onboarding step registry plus role views | **New**, but every completion check reuses existing facts |
| Persisted skip/resume of optional steps | **New** (decision needed, see C) |
| Quote-calculation explanation | **Reuse** (`quoteEstimate.ts` text becomes an article, plus a unit test that pins article numbers to code constants) |
| Contextual page awareness | **New**, trivial: a `pageId` enum validated against the registry; no data payload |
| Chat UI desktop and mobile | **New**, built on existing primitives |
| Feedback capture | **Reuse** `trackEvent` (confirm it accepts a properties JSON; otherwise add the field) |
| Conversation retention | **Not needed** (stateless; history lives in React state) |
| Future action registry | **New, types only** in v1 |
| Evaluation dataset (≥100) | **New** (`eval/datasets/v3`) |
| Cost metrics | **Reuse** observer and `aiCost.ts` (add a `COPILOT` entry) |

## Deliverable C — Technical architecture

### Data flow (`POST /api/assistant/chat`)

1. Middleware: `requireAuth` → `requireVerifiedEmail` → `requireFeature('copilot')` → `copilotRateLimit` → `validate(zod)`.
2. The server resolves the role from `userBelongsToWorkspace` / `getWorkspaceRole`. It never reads a role from the client.
   Pilot allowlist and plan/billing state are checked (a lapsed workspace gets the fallback).
3. Input is redacted with `redactSensitiveData`, capped at 600 chars, with at most 6 prior turns at 600 chars each (client-held).
4. `pageId` is checked against the shared route registry. An unknown value is treated as `unknown`; it is never an error.
5. Retrieval: `retrieve(question, {role, features, pageId})` scores keyword/BM25 over in-memory articles. The filters
   apply **before** scoring: `audience` includes the role, the feature is enabled in this deploy, `status==='live'`.
   Return the top 4 sections, capped at about 2.5k tokens.
6. Setup snapshot (booleans only, e.g. `{businessProfile:true, crew:false, mailbox:'unavailable'}`) comes from the onboarding
   registry. It contains no names, amounts, emails or customer data.
7. Meter: Copilot-specific check-and-increment (below). Then one model call with a system prompt, fenced
   `<kb_doc>` blocks and `<user_question>`. The system prompt states that fenced content is data, that the model may only
   cite supplied IDs, and that it must set `status:"unsupported"` when the docs do not cover the question.
8. `parseAiJson(CopilotResponseSchema)`, then **server post-validation**:
   - each `{documentId, sectionId}` must be among the sections supplied this request, otherwise drop it;
   - `navigation.routeId` must exist in the registry **and** be permitted for this role and feature, otherwise drop it;
     the URL is built server-side from `routeId`, never from model text;
   - an answer with no valid citation is downgraded to `needs_clarification` plus the top articles as links;
   - dollar-like figures in the answer that are not present in the cited sections cause a downgrade (financial-safety check);
   - answer capped at 1,200 chars.
9. Failure at any step (breaker open, timeout, schema error, budget exhausted, kill switch) returns HTTP 200 with
   `status:"unsupported"`, `degraded:true`, the deterministic top-3 article links and the checklist. Quota is refunded on failure.
   The UI never shows a dead end.

### Contracts (add to `RouteContracts`)

- `POST /api/assistant/chat` — `{workspaceId, question, pageId?, history?}` → `{answer, citations[], navigation?, status, degraded?, answerId}`
- `GET /api/assistant/context?workspaceId&pageId` → `{role, pageId, suggestedQuestions[], contextualHelp[]}` (static, registry-driven, no model call)
- `GET /api/assistant/onboarding?workspaceId` → `{version, steps[{id,title,state:'complete'|'incomplete'|'unavailable'|'optional'|'skipped',routeId,why}], percent}`
- `POST /api/assistant/feedback` — `{workspaceId, answerId, rating, reason?}`; the reason is an enum, with no free text in v1.

### Knowledge catalogue

- `packages/backend-core/src/knowledge/` containing `catalogue.ts` (typed index) and one Markdown file per article, imported at build time.
- Article front matter: `id`, `title`, `category`, `routeId?`, `audience: Role[]`, `requiresFeature?`, `status: live|unreleased`, `reviewedAt`, `reviewedAgainstVersion`.
- Because it ships in the image, "docs match the deployed version" holds by construction. `unreleased` articles are excluded at runtime.
- CI check `check:knowledge`: every `routeId` exists in the registry; ids are unique; `reviewedAgainstVersion` is not older than the last N
  releases touching that area; `status:live` articles may only reference features that `launchControls` / the registry mark shippable.
- Retrieval stays keyword/BM25 in-process. Add embeddings only if the eval shows recall below 90% at k=4.

### Onboarding registry

- `packages/shared` defines `SETUP_STEPS` (versioned), each with `id`, `audience`, `requiresModule`, `optional`, `routeId` and `check(workspaceId)`.
- The server computes state and the model never decides it. Checks reuse: `Workspace` fields and `onboardingCompleted`, `getSendReadiness`
  checks, `WorkspaceEmailConfig`, discovery profile, `OpsCrewMember` + `crewRateSummary` (rated crew), `Quote` with `estimate`, `Job`.
- `unavailable` means the module or plan is not enabled; a job-management-only workspace never sees the mailbox step.
- Role views: owner/admin get the business steps; a field worker gets 2–3 steps (see today's jobs, clock in, add photo evidence).
- **Skip/resume persistence (needs your decision):** the migration-free option is a `trackEvent('onboarding.step_skipped')`
  row, read back as state (12-month retention is acceptable for a skip). If that proves hacky in review, Phase 4 may add one
  small additive JSON column. No migration is justified in Phases 0–3.

### Storage, retention, audit

- No conversation storage. The question and answer are never persisted. Per-request log fields: workspaceId, userId, pageId,
  doc ids, status, latency, tokens (from the observer), model. Question text is not logged.
- Feedback and usage: `trackEvent` and `UsageRecord` with `action='COPILOT'`. `assertAiUsageAllowed` only sums `AI_*` actions,
  so this does not touch the outreach pool and needs no migration.
- Copilot meter: per-workspace daily cap (default 30) plus a monthly dollar ceiling (default A$ equivalent of about $2), both
  env-tunable like `AI_SPEND_CEILING_CENTS_*`. When exhausted, return the deterministic fallback.
- `recordAudit` is used only for denials (cross-workspace attempt, unknown route) and kill-switch/budget trips, not for every chat.

### Read-only guarantee (defence in depth)

1. The module exposes no tools or function-calling; the model returns JSON text only.
2. A new ratchet `scripts/check-copilot-readonly.mjs` (same style as the existing `check-*.mjs`) fails CI if files under
   `copilot/` import `prisma` write methods, `$executeRaw`, `mail`, `stripe` or any service module not on an allowlist
   (usage meter and `trackEvent` only).
3. A DB-tier test asserts zero row changes in business tables across a full Copilot request (counting writes via the Prisma extension).

### Future actions (types only in v1)

`ActionDefinition<I,O>`: `{id, permission: Permission, inputSchema(zod), preview(input): Diff, execute(ctx, input), idempotencyKey, confirm:'required'|'separate_approval', audit}`.
The registry is **empty and unwired** in v1. The model only ever proposes `{actionId, input}`; `preview` renders the exact changes; confirmation hits an
existing service function behind `assertWorkspacePermission`. Email send stays behind the existing `sendAuthorization` plus its own approval.

## Deliverable D — Implementation plan (each row = one reviewable PR; no migrations)

| PR | Content | Depends on | Key files | Tests | Rollback |
|---|---|---|---|---|---|
| 1 | Promote the route registry to `packages/shared` (`routeId`, path, `minRole`, `fieldWorker`, `feature`); web `router.ts`/`hubs.ts` consume it | none | `packages/shared`, `apps/web/src/lib/router.ts`, `hubs.ts` | existing `router.test`, `hubs.test` unchanged and green; new registry-parity test | revert; no behaviour change |
| 2 | Knowledge catalogue: format, loader, BM25 retrieval, `check:knowledge`, first 15 articles (getting started, quoting, FieldOps) | 1 | `backend-core/src/knowledge/` | retrieval unit tests, role/feature filtering | revert; unreferenced |
| 3 | Onboarding registry plus `GET /api/assistant/onboarding`, `context` (no AI); deterministic checklist card in the dashboard | 1 | `packages/shared`, `apps/api/src/routes/assistant.ts`, web card | step-state tests against fixtures; role-view tests; tenant-isolation DB test | flag `COPILOT_ONBOARDING`; remove the card |
| 4 | Remaining articles (to ~40) and `eval/datasets/v3` (≥100 labelled Qs) plus the offline retrieval eval gate | 2 | `eval/datasets/v3`, `scripts/eval-offline.mjs` | recall@4 ≥ 90% offline | revert |
| 5 | Backend chat: export a generic JSON entry from `openai.ts`, orchestrator, validation, `copilotRateLimit`, meter, `Feature 'copilot'`, `POST chat/feedback`, fallback | 2, 3 | `services/openai.ts`, `routes/assistant.ts`, `launchControls.ts`, `limits.ts`, `aiCost.ts` | injection, citation and navigation validators, provider-fail, budget-exhausted, read-only ratchet and DB write test | `FEATURE_COPILOT=false`; chat 503 → UI shows fallback |
| 6 | Panel UI: desktop side panel; mobile floating button plus full-height sheet; suggested questions; links; error and retry; "report incorrect answer" | 5 | `web/src/components/copilot/*`, `App.tsx`, `routeApi` contracts | RTL tests; Playwright at 390px with keyboard open and no horizontal scroll; Save buttons stay reachable | `VITE_COPILOT=false` (same pattern as `VITE_HUB_NAV`) |
| 7 | Contextual entry points ("Help with this estimate", Settings, Crew); page-id wiring | 6 | quote card, settings sections | click-through e2e | remove entry points |
| 8 | Hardening: adversarial suite (injection in questions and in article text), tenant/role matrix, financial-safety cases, a11y, cost and latency dashboard (`ops/monitoring`) and alerts | 5–7 | `tests/`, `tests-db/`, `ops/monitoring` | full gates in E | n/a |
| 9 | Pilot enablement: `COPILOT_WORKSPACE_ALLOWLIST`, runbook, weekly eval run, feedback review | 8 | `docs/runbooks`, `eval.yml` | smoke test | remove from the allowlist |

PRs 2/3 and 4 can run in parallel with the PR 5 backend after PR 1. PR 3 delivers value without any model call.

## Deliverable E — Evaluation plan

| Gate | Threshold (proposed) | Where |
|---|---|---|
| Tenant isolation and authorisation | 100% pass: a member cannot get admin docs or admin-only routes; workspace A never receives B's data | `tests-db/` |
| Unauthorised writes | 0 (static ratchet plus DB write-count test) | CI |
| Invalid navigation or citation | 0 across the ≥100-question set; validator rejects every invented id | offline, deterministic |
| Grounded-answer accuracy | ≥ 90% on the human-reviewed set (live, weekly via `eval.yml`) | live |
| Retrieval recall@4 | ≥ 90% offline, before enabling the model | offline |
| Prompt injection | 0 critical failures: injection in the question and in the article body cannot change status, citations, route or system rules | adversarial |
| Financial safety | 0 invented dollar amounts or margins; `unsupported` for any question that asks to compute a customer's actual numbers | adversarial |
| Provider failure | timeout, 5xx, open breaker and schema error each return a 200 fallback in < 2s | tests |
| Mobile | 390px: no horizontal scroll, keyboard open, Save visible | Playwright |
| Cost and perf | p95 latency target to be set from pilot data; Copilot cost per active workspace reported weekly | metrics |
| Regression | the full existing suite green; the `check:*` ratchets unchanged | CI |

The dataset ratio is roughly: onboarding 25, quoting 20, FieldOps 20, discovery 15, billing 10, troubleshooting 10, plus about 15 adversarial and
unsupported cases. Labels are written from the article text, not from model output, per the convention in `eval/README.md`.

## Deliverable F — Effort and risk

| Phase | Estimate (one engineer) |
|---|---|
| 0 Audit and design | done (this document); review about 0.5 d |
| 1 Catalogue and eval (PR 1, 2, 4) | 2–2.5 wk, mostly content writing and review |
| 2 Backend (PR 5) | 1.5 wk |
| 3 UI (PR 6, 7) | 1.5 wk |
| 4 Onboarding (PR 3) | 1–1.5 wk |
| 5 Hardening (PR 8) | 1 wk |
| 6 Pilot (PR 9) | 2 wk calendar, about 2 d of effort |
| **Total to pilot** | **about 7–8 engineer-weeks; the Copilot Lite subset is about 5** |

**Critical dependencies and risks**

1. **Article content** is the long pole and the accuracy risk. The founder or product owner must review each article.
2. **Unreleased-feature drift** (e.g. quote estimate, relationship graph): mitigated by `status` plus the CI check, but the
   `reviewedAgainstVersion` rule needs a disciplined owner.
3. **Shared AI pool**: do not add Copilot to the `AI_*` actions. It would exhaust free/starter outreach quotas.
4. **Technician identity** on the server needs confirming before the field-worker view is built.
5. **Provider is OpenAI.** A$ cost in the brief is an assumption. The repo's own estimates (`aiCost.ts`: roughly 0.22–0.32 US cents per call at
   `gpt-5-mini`) suggest a grounded-Q&A call of similar size sits near the low end of the A$0.005–0.03 range. Treat that as an estimate, not a quote,
   and measure it in the pilot using the observer's token counts.
6. **Pending quoting migrations/staging** should land first, as you suggested. PR 1–4 touch no schema, so they can start in parallel.
7. **Per-workspace flag absence**: the env allowlist is a stopgap. It is fine for five pilots, not for general availability.

## Decisions needed from you before Phase 1

1. Confirm the pilot audience: owners/admins and field workers only (recommended), or all members.
2. Approve skip/resume storage via `trackEvent` (migration-free) versus a later small column.
3. Name the article reviewer, and agree that `unreleased` content is excluded until deploy.
4. Confirm that the first PRs may precede the quoting-migration verification (they are schema-free).
