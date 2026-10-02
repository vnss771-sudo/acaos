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
| Operator console | 14 |
| FieldOps loop | 15 |

## Done (merged to `master`; current head is `4b7c1e8`)

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
- **Route order.** In `routes/commercialOpportunities.ts`, a static path such as
  `/outcomes` must be registered before `/:id`.
- **OpenAI in DB tests.** Stub `globalThis.fetch` for OpenAI URLs only, and pass
  other URLs through, because the test server uses fetch. See
  `tests-db/opportunity-intent.test.ts`.

## Next phases (to do)

### Phase 11: Closed-loop learning (next)

**Goal.** For every opportunity that closed or stalled, say why, and turn repeated
causes into proposals a human approves.

**Build on:**
- `lib/outcomeGraph.ts`: `buildOutcomeChain` gives each chain's nodes, final
  outcome and attribution. `outcomeGraphStore.ts` has batched, workspace-scoped
  loaders.
- `CommercialOpportunity`: its `scorecard`, `buyingStageDetail`, `recommendation`
  (with citations and ages) and `intelligenceGate`, and its `CommercialEvent`
  status (an ACTIVE event that went STALE suggests the signal was wrong).
- `OutreachSent`: `replyIntent` is one of INTERESTED, NOT_INTERESTED,
  NEEDS_MORE_INFO, NOT_NOW, OUT_OF_OFFICE or REFERRAL; `status` includes BOUNCED.
- `OutreachIntent.grounding`, which records whether the draft that went out was
  grounded.
- The existing learning loop:
  - `LearningRecommendation` model: its types today are ICP_INDUSTRY, ICP_SIZE and
    SIGNAL_WEIGHT; its statuses are PENDING, APPROVED, REJECTED, SUPERSEDED and
    APPLIED_AUTOMATICALLY.
  - `lib/learningDecisions.ts`: the only path that applies a proposal. It's
    race-safe, stale-safe, expiring and audited.
  - `apps/worker/src/processors.ts` `calibrateScoring`: gated by
    `LEARNING_ADAPTATION_MODE` (off, shadow, approved or live).
  - `routes/workspaces/learning.ts`.

**Suggested shape.** Keep it deterministic, with no model calls.

1. **`lib/outcomeCauses.ts` (pure).** `attributeCause(chain, opportunity, sends)`
   returns `{ cause, confidence, reasons[] }`. Its causes:

   | Cause | Signs |
   |---|---|
   | WRONG_SIGNAL | The event went STALE, the intelligence gate was false, or the stage regressed |
   | WRONG_TIMING | The reply was NOT_NOW, the send went out before ACTIVE_REQUIREMENT, or the evidence was more than N days old at send |
   | WRONG_CONTACT | A bounce, a REFERRAL reply, or low contactability |
   | BAD_MESSAGE | A good opportunity (corroborated, active stage) was sent to and got no reply within N days, or the draft wasn't grounded |
   | LOST_TO_COMPETITOR | LOST with high competition, or after a quote |
   | UNKNOWN | None of the above |

   Only closed chains (WON or LOST), or chains stalled past a window, get a cause.
   WON gets `cause: null`.
2. **`summarizeCauses` (pure).** Counts per cause, per event kind, per offer and per
   buying stage, with sample sizes. Below a minimum sample (reuse
   `learningLoopMinOutcomes()`), report it but don't propose.
3. **Proposals → `LearningRecommendation`, PENDING only (shadow).** Never
   APPLIED_AUTOMATICALLY in this phase, even when the mode is `live`.
   - **Decision needed from the user:** should the new proposal types be
     advisory or config-writing?
     - Advisory: approving acknowledges the proposal; nothing changes.
     - Config-writing: for example an event-kind weight, or the WAIT days per
       stage. This needs `valueSchemas` and `writeLive` cases in
       `learningDecisions.ts` and somewhere to store the config.
   - **Recommendation:** advisory types in phase 11 (e.g. `OPPORTUNITY_CAUSE`), with
     `evidence` holding the counts and example opportunity ids. Leave config-writing
     to phase 12, which owns the weights.
   - **Ask the user before building config-writing types.**
4. **Hook.** A worker step next to `calibrateScoring`, under the same mode gate
   (`off` does nothing). Supersede older PENDING proposals of the same type, the
   way `calibrateScoring` does.
5. **API.**
   - Add `cause` to `GET /api/commercial-opportunities/:id/outcome`.
   - Add cause counts to `GET …/outcomes`.
   - Proposals show up in the existing learning routes.
6. **Tests.**
   - Unit tests: one per cause, the precedence between causes, and summary sample
     thresholds.
   - DB tests: seed chains, then run the hook. Check that PENDING proposals appear,
     that `off` writes nothing, and that `live` still doesn't auto-apply.
   - Mutation-check the cause rules.

### Phase 12: Signal calibration
- Conversion rates: signal → opportunity → conversation → quote → win → revenue.
- Lift for event combinations ("A+B+C is 6.7× more likely than A alone").
- Use it to calibrate the scoring weights, still through approval.

### Phase 13: Cross-customer intelligence
- Aggregated and anonymised only.
- No workspace's private data may leak into another workspace.

### Phase 14: Operator console (web UI)
The "what should I do today" home screen:
- opportunities that need attention, with evidence and approve/dismiss actions
- opportunities to monitor
- new signals
- pipeline influenced by ACAOS

It reads the `commercial-opportunities` and `evidence-graph` APIs.

### Phase 15: FieldOps loop
- Quote → won → job → job value feeds back into ACAOS outcomes.
- `Opportunity.opsJobSiteId` already exists for tender records.

## Open gaps worth noting

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

> Read `docs/ACQUISITION_OS_BUILD_PLAN.md` and the docs it links. Continue with phase 11
> (closed-loop learning), following the invariants, workflow and lessons there. Before
> building config-writing proposal types, ask me (the plan recommends advisory types
> first). Open a PR and merge it when CI is green. Be conservative with tokens.
