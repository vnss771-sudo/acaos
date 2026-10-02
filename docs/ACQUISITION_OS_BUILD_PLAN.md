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

## Done (merged to `master`; current head is `c039b9e`)

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
| 10 Outcome graph | (this PR) | Read model chaining each opportunity through recommendation → intent → send → reply → meeting → quote → won/lost → revenue; sourced vs influenced attribution; funnel summary API | `lib/outcomeGraph.ts`, `lib/outcomeGraphStore.ts` | `ACQUISITION_OS_OUTCOMES.md` |

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

## Next phases (to do)

### Phase 11: Closed-loop learning
- Attribute each outcome to a cause: wrong signal, wrong timing, wrong contact, bad
  message, or lost to a competitor.
- Proposals go to `LearningRecommendation` (a human approves). Shadow by default.
- Start from `buildOutcomeChain` (phase 10): the chain says how far each
  opportunity got and when, so "no reply", "lost after the quote" and so on are
  readable from it.

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
- Draft grounding checks specifics (numbers, amounts, percentages) and fact use; a
  qualitative invented claim with no number isn't caught deterministically.

## Kick-off prompt for the next session

> Read `docs/ACQUISITION_OS_BUILD_PLAN.md` and the docs it links. Continue with phase 11
> (closed-loop learning), following the invariants and workflow there. Open a PR and
> merge it when CI is green. Be conservative with tokens.
