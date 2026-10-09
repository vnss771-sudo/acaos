# ACAOS Acquisition OS — build plan and handoff

Paste this into a new session, or point the session at this file.

## Goal

Turn ACAOS into a closed-loop acquisition operating system. The core unit is the
**commercial opportunity**, not the lead:

Observe → Corroborate → Understand → Predict → Recommend → Execute → Measure → Learn

The plan has 15 phases, grouped into release trains:

| Release train | Phases |
|---|---|
| Intelligence foundation | 1–2 |
| Opportunity OS | 3–6 |
| Decision engine | 7–8 |
| Autonomous execution | 9 |
| Revenue learning | 10–12 |
| Network | 13 |
| FieldOps loop (delivery economics) | 15A–C |
| Operator console | 14 (done) |

## Done (merged to `master`)

| Plan phase | PR | What | Key files | Docs |
|---|---|---|---|---|
| zip phases 2–3 | #316 | Commercial-event classifier, offer fit, next-best-action; nodemailer bumped to 10.0.13 | `lib/commercialEvent.ts`, `offerIntelligence.ts`, `nextBestAction.ts` | `ACQUISITION_OS_PHASE2/3.md` |
| 1 Signal intelligence | #318 | Canonical signal, per-signal quality (reliability, freshness, specificity, relevance, offer fit, corroboration), velocity, `Signal.publishedAt` | `lib/signalIntelligence.ts` | `ACQUISITION_OS_FOUNDATION.md` |
| 4 Offer model | #318 | `Offer` table + `/api/offers`: triggers, qualifying/disqualifying keywords, geography, deal values | `lib/offerModel.ts`, `routes/offers.ts` | same |
| 5 Opportunity engine | #318 | `CommercialOpportunity` (one per prospect × offer), store, worker hook, `/api/commercial-opportunities` | `lib/opportunityEngine.ts`, `commercialOpportunityStore.ts` | same |
| 3 Event engine | #319 | 14 event kinds in families, implications, per-event gate 1 | `lib/commercialEventEngine.ts` | `ACQUISITION_OS_EVIDENCE_GRAPH.md` |
| 2 Evidence graph | #319 | `CommercialEvent` + `EvidenceLink` tables, `/api/evidence-graph/:prospectId` | `routes/evidenceGraph.ts` | same |
| 6 Scoring 2.0 | #320 | Scorecard: value, intent, timing, fit, evidence, contactability, competition; probability, expected value, priority | `lib/opportunityScoring.ts` | `ACQUISITION_OS_SCORING.md` |
| 7 Buying stage | #321 | Seven stages, a move per stage, a stage gate on "contact now", `buyingStageDetail` | `lib/buyingStage.ts` | same |
| 8 Recommendation engine | #323 | Ten explained moves per opportunity, citing evidence; gate 2 withholds what can't be explained; outreach moves bridged to one `Recommendation` row (no intent, no send) | `lib/recommendationEngine.ts` | `ACQUISITION_OS_RECOMMENDATIONS.md` |
| 9 Intelligence → execution | #324 | Operator proposes an `OutreachIntent` from an opportunity; drafts are written from verified facts and checked (claim → evidence → source → confidence); an ungrounded draft can't be approved | `lib/opportunityIntent.ts`, `lib/draftGrounding.ts` | `ACQUISITION_OS_EXECUTION.md` |
| 10 Outcome graph | #325 | Read model chaining each opportunity through recommendation → intent → send → reply → meeting → quote → won/lost → revenue; sourced vs influenced attribution; funnel summary API | `lib/outcomeGraph.ts`, `lib/outcomeGraphStore.ts` | `ACQUISITION_OS_OUTCOMES.md` |
| 11 Closed-loop learning | #327 | Deterministic cause per closed/stalled opportunity (competitor, contact, timing, signal, message); repeated causes become one advisory `OPPORTUNITY_CAUSE` review per workspace — PENDING in every mode, approve changes nothing | `lib/outcomeCauses.ts`, `lib/outcomeLearning.ts` | `ACQUISITION_OS_LEARNING.md` |
| 12 Signal calibration | #328 | Funnel per event kind, combination lift, shrunk bounded event-kind weights proposed as `EVENT_KIND_WEIGHT` (approval only, never auto-applied); approved weights scale opportunity probability | `lib/signalCalibration.ts`, `lib/calibrationLearning.ts` | `ACQUISITION_OS_CALIBRATION.md` |
| 13 Cross-customer intelligence | #329 | Opt-in only (`Workspace.networkOptInAt`); per-kind counts pooled daily into the global `NetworkBenchmark` table above a floor of 10 workspaces and 50 closed outcomes (customers read bands and rates rounded to 5 points, never exact pooled counts); no identifying data stored; read and opt-in APIs | `lib/networkIntelligence.ts` | `ACQUISITION_OS_NETWORK.md` |
| 15A Commercial capture | #330 | `Quote` (one per opportunity of either type) and `Job` (1:1 job site); accepted quote → WON + job; closeout freezes economics (unknown never $0, labour vs gross margin); reopen audited; `/api/delivery/*`, all `ops:manage`; backfill of existing sites | `lib/jobEconomics.ts`, `routes/delivery.ts` | `ACQUISITION_OS_DELIVERY.md` |
| 15B Capture UI + observe | #330 | Quote capture on Find work; *Jobs & margins* view (closeout, reopen, gaps); `/api/delivery/report` (medians with n, withheld below 3); quotes drive outcome attribution | `views/ops/OpsDelivery.tsx`, `components/ops/QuoteCapture.tsx` | same |
| 14 Operator console | (this PR) | *Today* view (`/today`, Home hub): decisions (pursuing + high-urgency open) with evidence, citations and contact; new this week; worth watching; KPIs (open pipeline, won sourced/influenced, quote→win, admin-only delivered margin with n); pursue / lost / dismiss; admin propose-outreach (nothing sends), quotes on commercial opportunities, network opt-in | `views/Today.tsx` | this file |
| Hardening pass | (this PR) | Untrusted source URLs only render as links when http(s) (React 18 renders `javascript:` hrefs) in Today, Find work and the lead brief; shifts logged after closeout are flagged; end-to-end loop and tenant-boundary DB tests | `lib/safeUrl.ts`, `tests-db/delivery-loop.test.ts` | `ACQUISITION_OS_DELIVERY.md` |

**Pipeline per prospect.** It runs in `refreshCommercialOpportunities`, called from the
worker's `scoreProspects`. The kill switch is `COMMERCIAL_OPPORTUNITIES_ENABLED=false`.

1. signals → `toCanonicalSignal`
2. `detectCommercialEvents` → `syncEvents` (persists `CommercialEvent` and `EvidenceLink`)
3. for each applicable offer: `assessOpportunity`
   - choose the event for the offer
   - `evaluateOffer` (disqualifiers checked against 180 days of evidence)
   - `scoreOpportunity`
   - `inferBuyingStage`
   - `chooseNextBestAction`, then the gates
   - `recommendForOpportunity` (gate 2: no explanation, no recommendation)
4. upsert `CommercialOpportunity`, then sync its bridged `Recommendation` row

**After the pipeline (operator-driven, phases 9–10).**
- `POST /api/commercial-opportunities/:id/intent` creates a PROPOSED `OutreachIntent`
  carrying a grounding record.
- The existing routes then take it through draft → approve (the grounding gate) →
  materialise → send.
- `GET /api/commercial-opportunities/:id/outcome` and `GET …/outcomes` read the
  outcome graph.

## Invariants (don't break these)

- **Deterministic.** No model calls in scoring or decisions. Pass `now`; never read the
  wall clock inside an assessment.
- **Gate 1, intelligence truth.** Fewer than 2 independent sources (by URL host or
  provider), or no trustworthy signal, caps confidence at 60. Unusable, stale (> 30 days)
  or irrelevant evidence is dropped before any rule runs.
- **Gate 2, decision truth.**
  - Every recommendation carries its reasons.
  - Uncorroborated "contact now" is downgraded.
  - The stage gate allows "contact now" only from ACTIVE_REQUIREMENT through BUYING_DECISION.
- **Engagement drives the late stages.** Only recorded engagement (`Prospect.outcomeStage`
  MEETING/PROPOSAL/WON) moves a prospect to BUYING_DECISION or CUSTOMER.
- **Operator statuses are never overwritten.** PURSUING, WON, LOST and DISMISSED stay as
  the operator set them. The engine only sets OPEN and EXPIRED, and events go ACTIVE → STALE.
- **Nothing sends.** No autonomous sending was added; outreach still goes through the
  existing intent → approval → send path.
- **Migrations are additive only** (nullable columns, new tables). New workspace tables go
  in `TENANT_MODELS` (`lib/tenantGuard.ts`). Every query is scoped by `workspaceId`.
- **The legacy `Opportunity` table is separate.** It holds tender and DA records for Work
  discovery and FieldOps. Don't merge it into `CommercialOpportunity` without a decision
  from the user.

## Workflow conventions

- **Branch.** Use the session's designated branch, restarted from `origin/master` after
  each merge: `git checkout -B <branch> origin/master`, then `push --force-with-lease`.
- **Migrations.** Generate them; don't hand-write them:
  `prisma migrate diff --from-schema-datamodel <old.prisma> --to-schema-datamodel packages/db/prisma/schema.prisma --script`.
  This needs dummy `DATABASE_URL` and `DIRECT_URL` values. Copy the old schema before editing.
- **Before pushing, all of these must pass:**
  - `npm run verify` (lint, typecheck, unit and web tests, build, repo checks)
  - `npm run test:coverage` (84% lines / 78% branches / 87% functions)
  - `npm run test:db:local` (local Postgres 16, with its own coverage gate)
  - **Offline stub compile:** `ACAOS_SKIP_PRISMA_POSTINSTALL=1 npm run prisma:generate`,
    then `tsc --noEmit` for backend-core, api and worker, then `npm run prisma:generate`
    to restore the real client.

    The stub makes Prisma results untyped, so annotate row types: `(rows as Array<{ id: string }>)`.
- **Tests.**
  - Unit tests go in `tests/lib-*.test.ts`. DB tests go in `tests-db/*.test.ts`, using
    the `tests-db/helpers/db.ts` helpers.
  - JSON request bodies need `JSON.stringify` and a `Content-Type` header.
  - Mutation-check new gates: temporarily break the rule and confirm a test fails.
- **For a focused DB run,** start your own Postgres under `/tmp` (the postgres user
  can't read the scratchpad).
- **PRs.**
  - Open each PR yourself.
  - Subscribe to its activity, and set a backup check-in about 50 minutes out.
  - The user has asked for merges when CI is green. Merge with
    `merge_method: merge`, pinned to the full head SHA (`git rev-parse`).
  - After merging, unsubscribe and delete the check-in.
- **Commits** end with the session's Co-Authored-By and Claude-Session lines.
- **One phase per PR.** If you start the next phase while a PR is in CI, keep the work
  local, uncommitted or in a local commit. Once the PR merges, restart the branch
  from `origin/master` and cherry-pick the work. Pushing earlier would add it to
  the open PR.

## Lessons from the phase 8–10 session

- **Check exit codes, not grep's.** `cmd | grep … && git push` pushed a failing test
  once. Run a test step on its own, then check `$?` before committing.
- **CodeQL runs as its own check, separate from CI.** A host-like substring check in a
  test, such as `x.includes('news.example.org')`, raises a high "incomplete URL
  substring sanitization" alert. Compare against the computed value instead.
- **Reading alerts:** the code-scanning API returns 403 from here. Use
  `gh api repos/<o>/<r>/check-runs/<id>/annotations` instead.
- **Job logs:** `gh api …/jobs/<id>/logs` is blocked (blob storage 403). Use the GitHub
  tool `get_job_logs` with `return_content: true`.
- **Waiting on CI:** use a background loop on
  `gh api "repos/<o>/<r>/commits/<sha>/check-runs?check_name=required"`, which
  re-invokes you when it exits. The `required` check aggregates every job.
- **Re-runs:** a failed job can only be re-run after the whole workflow completes
  (`…/runs/<id>/rerun-failed-jobs`).
- **Known web-suite fragility.** `OpsShifts.test.tsx` has timing-sensitive tests
  that already retry. One timed out once in CI. A leaked poll timer in
  `settingsSections.ts` was fixed in #325. Read the vitest output for "Unhandled
  Errors" before calling a failure a flake.
- **One PENDING proposal per type.** `LearningRecommendation` has a partial unique
  index on `(workspaceId, type) WHERE status = 'PENDING'`. Fold multiple findings
  into one proposal, as phase 11 does.
- **Route order.** In `routes/commercialOpportunities.ts`, a static path such as
  `/outcomes` must be registered before `/:id`.
- **OpenAI in DB tests.** Stub `globalThis.fetch` for OpenAI URLs only, and pass
  other URLs through, because the test server uses fetch. See
  `tests-db/opportunity-intent.test.ts`.

## Next phases (to do)

**State:** phases 1–15B and 14 are done. What remains is 15C, which waits on real
closed jobs rather than on code, and launch (below). Until then, prefer hardening
and polish driven by real use over new intelligence. Read `docs/ACQUISITION_OS_DELIVERY.md`
first: its economic truth rules are invariants, like the gates above.

### Phase 15C: Margin intelligence (advisory) — when real closed jobs exist
See `ACQUISITION_OS_DELIVERY.md`. Expected profit = value × P(win) × margin, with
P(win) counted once; proposals only; every figure with its *n*.

## When funding arrives: shortest path to live

The code side is ready; what remains is accounts, keys and infrastructure. Work
through `docs/GO_LIVE_CHECKLIST.md` top to bottom. In short:
1. Postgres (with PITR) and Redis; run `prisma migrate deploy`.
2. Secrets from `docs/PRODUCTION_ENV_VARS.md` (JWT, encryption key, OpenAI, Stripe,
   SMTP/IMAP, metrics token).
3. Domain, TLS, SPF/DKIM.
4. Deploy api, worker and web images; run `npm run smoke:deploy`.
5. Start with `SAFE_LAUNCH_MODE=true` for the supervised pilot.

## Open gaps worth noting

- Any new link built from data must go through `safeExternalUrl` (`apps/web/src/lib/safeUrl.ts`).

- No ingest path sets `Signal.publishedAt` yet.
- Competition is inferred from the event kind, not real bidder counts.
- There are no company-to-company relationships in the graph yet.
- `syncEvents` rewrites evidence links on every rescore. It's correct but write-heavy;
  skip unchanged events if it shows up in load.
- Scoring weights are hand-set until phases 11–12.
- `ProspectOutcome` is per prospect, so one recorded win counts toward each of the
  prospect's opportunities (one per offer).
- Draft grounding checks specifics (numbers, amounts, percentages) and fact use; a
  qualitative invented claim with no number isn't caught deterministically.

## Kick-off prompt for the next session

> Read `docs/ACQUISITION_OS_BUILD_PLAN.md` and the docs it links. Phases 1–15B and 14 are
> done; follow the invariants, economic truth rules, workflow and lessons there. Start 15C
> only once workspaces have real closed jobs. Open a PR and merge it when CI is green. Be conservative with tokens.
