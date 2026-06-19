# Learning Loop — Framework vs. Implementation Comparison

**Date:** 2026-06-19
**Branch:** `claude/learning-loop-framework-jkqum5`
**Scope:** Compares the canonical learning-loop framework
(*Learn → Apply → Reflect → Refine → Repeat*) against what ACAOS actually
implements today.

---

## TL;DR

ACAOS already implements a closed learning loop, but it is a **scoring-model
calibration loop**, not a generic skill-mastery loop. All five stages of the
framework are present in some form. The two weakest stages are **Reflect**
(it measures *outcomes* but does not diagnose *why* a weight moved) and
**Repeat** (the loop only fires on a WON/LOST event — there is no scheduled,
guaranteed re-run like the IMAP sync has).

| Framework stage | Implemented? | Where | Strength |
|-----------------|:-----------:|-------|----------|
| **Learn**   | ✅ Full | `prospectOutcome` capture + `calibrate()` weight derivation | Strong |
| **Apply**   | ✅ Full | `signalEngine.calculateOpportunityScores()` consumes learned `signalWeights`/ICP | Strong |
| **Reflect** | ⚠️ Partial | `performanceMetrics` (win rate, counts) on `ScoringModel` | Weak — descriptive, not diagnostic |
| **Refine**  | ✅ Full | `calibrateScoring()` upserts new `signalWeights` + ICP band | Strong |
| **Repeat**  | ⚠️ Partial | `enqueueCalibrate()` fires on each WON/LOST outcome | Weak — event-only, no schedule |

---

## Stage-by-stage

### 1. Learn — *Acquire new knowledge or skill*

**Framework:** Acquire new knowledge from a source.

**Implementation:** Knowledge enters the system as **outcomes**. When an operator
marks a prospect `WON`/`LOST`, `POST /api/prospects/:id/outcome`
(`apps/api/src/routes/prospects.ts:782`) writes a `ProspectOutcome` row. The
calibrator then reads up to the **100 most recent** real (non-example) outcomes
(`apps/worker/src/processors.ts:141`) and derives per-signal-type win rates.

- ✅ Real signal: learns from *ground truth* (closed deals), not vanity metrics.
- ✅ Guards against poisoning: `isExample` prospects are excluded from learning
  (`processors.ts:142`, enforced again at the API in `prospects.ts:790`).
- ⚠️ **Cold-start gate:** `MIN_OUTCOMES = 10` (`learningLoop.ts:30`). Below 10
  outcomes the loop returns `calibrated: false` and learns nothing — correct, but
  it means most workspaces never enter the loop. The pilot runsheet calls this
  out explicitly (`docs/pilot/PILOT_RUNSHEET.md:89`).
- ⚠️ **Sliding window of 100** silently caps memory. Older outcomes are forgotten;
  there is no decay or weighting by recency *within* the window.

### 2. Apply — *Use it in a real or simulated context*

**Framework:** Apply the new knowledge in a real context.

**Implementation:** Learned weights are applied on the **next scoring pass**.
`scoreProspects()` (`processors.ts:68`) loads the workspace's `ScoringModel.signalWeights`
and `WorkspaceICP`, then `calculateOpportunityScores()`
(`signalEngine.ts:197`) uses them as per-signal caps in `calcIntentScore`
(`signalEngine.ts:99`) and as the ICP band in `calcFitScore` (`signalEngine.ts:161`).

- ✅ Tight Learn→Apply coupling: recording a WON/LOST enqueues **both**
  `enqueueScoreProspects` and `enqueueCalibrate` (`prospects.ts:818-819`), so
  learning and re-application happen back-to-back.
- ✅ Application flows downstream automatically: a rescored prospect over the
  auto-recommend threshold enqueues `generate-recommendations`
  (`worker.ts:308`), which feeds the outreach spine.
- ⚠️ Ordering is not guaranteed — score and calibrate are independent queue jobs;
  a rescore may run against the *previous* weights, corrected only on the next
  outcome. (Self-healing but not immediate.)

### 3. Reflect — *Analyze what worked, what didn't, and why*

**Framework:** Analyze what worked, what didn't, **and why**.

**Implementation:** This is the **thinnest** stage. `calibrateScoring` records
`performanceMetrics = { totalOutcomes, winRate, calibratedAt }` and bumps
`updateCount` on the `ScoringModel` (`processors.ts:167-186`).

- ✅ Captures *what* (baseline win rate, sample size, timestamp, update count).
- ❌ No *why*: there is no record of **which weights changed, by how much, or
  whether the last calibration actually improved win rate**. The loop cannot tell
  a good adjustment from a bad one — it has no feedback on its own feedback.
- ❌ No holdout / no before-vs-after comparison. `calibrate()` is a pure function
  of the current window (`learningLoop.ts:32`, verified pure by test
  `lib-calibrate`/`learning-loop-stress.test.ts:289`), so it cannot regress-test
  itself.
- ❌ The reply-classification path writes `ScoringOutcome` rows
  (`worker.ts:228`) with `messageRelevance`/`replyIntent`, but **these are never
  read by `calibrate()`** — a second, partially-orphaned reflection signal.

> **Biggest gap vs. the framework.** "Reflect" here is bookkeeping, not analysis.

### 4. Refine — *Adjust your approach based on reflection*

**Framework:** Adjust the approach based on reflection.

**Implementation:** `calibrate()` turns per-type win-rate **lift** into bounded
weight multipliers and an ICP band (`learningLoop.ts:56-89`):

- Per-signal multiplier = `winRate(type) / baselineWinRate`, **clamped to
  [0.5×, 2.0×]** of the base weight (`learningLoop.ts:60-63`). Bounded
  adjustment — no runaway weights.
- Requires **≥3 samples per signal type** before adjusting it
  (`learningLoop.ts:58`) — avoids overfitting to a single deal.
- ICP refinement: top-5 WON industries (lowercased) + the **10th–90th percentile
  employee band** from WON deals (`learningLoop.ts:74-89`).
- ✅ Results are persisted via `upsert` (`processors.ts:173`, `:191`), so refinement
  is durable and versioned by `updateCount`/`lastWeightUpdate`.
- ✅ Mathematical invariants are well-tested: finite, non-negative integer
  weights; clamp floors/ceilings; `minEmployees ≤ maxEmployees`
  (`learning-loop-stress.test.ts:84-235`).

This stage is robust and matches the framework well.

### 5. Repeat — *Cycle accelerates mastery*

**Framework:** Repeat the cycle continuously.

**Implementation:** The loop re-arms on **every definitive outcome**:
`enqueueCalibrate(workspaceId)` fires whenever a prospect is marked WON/LOST
(`prospects.ts:817-819`).

- ✅ Self-perpetuating during active selling — more deals ⇒ more calibration.
- ⚠️ **Event-driven only.** Unlike IMAP sync, which has a guaranteed repeatable
  scheduler (`syncQueue.upsertJobScheduler(..., { every: 10 min })`,
  `worker.ts:466-475`), calibration has **no time-based trigger**. A workspace
  that stops recording outcomes stops learning, even as signals/market drift.
- ⚠️ No convergence/early-stop logic and no per-workspace cadence control — it
  recalibrates from scratch on each outcome regardless of whether anything
  meaningfully changed.

---

## Concrete gaps & recommended refinements

Ordered by impact-to-effort.

1. **Strengthen Reflect (highest value).** Persist a calibration *diff* in
   `performanceMetrics`: previous vs. new `signalWeights`, the win rate of the
   prior model, and a simple "did win rate improve since last calibration?" flag.
   This is the missing "why" and makes the loop self-auditing.

2. **Add a scheduled Repeat.** Mirror the IMAP pattern with a repeatable
   `calibrate-scoring` scheduler (e.g. nightly per active workspace) so learning
   continues during quiet periods and adapts to drift. Keep the event trigger for
   responsiveness.

3. **Unify the two outcome signals.** Either feed `ScoringOutcome` (reply
   intent / message relevance) into `calibrate()`, or document why it is separate.
   Right now reply-level learning is captured but unused by the calibrator.

4. **Recency weighting inside the window.** The 100-row window treats a deal from
   today the same as one from months ago. Weight by recency (cf. the exponential
   decay already used for signals in `signalEngine.ts:46`) for faster adaptation.

5. **Guard against silent regressions.** Before promoting new weights, optionally
   compare against a small holdout of recent outcomes; skip the update if win-rate
   estimate worsens. Turns Reflect from descriptive into corrective.

---

## Verdict

ACAOS implements a **genuine, production-grade closed loop** — Learn, Apply, and
Refine are all real and well-tested. It diverges from the ideal framework mainly
in **Reflect** (measures outcomes but does not analyze *why* an adjustment helped
or hurt) and **Repeat** (fires on outcomes but lacks a guaranteed schedule). The
two are linked: without a richer Reflect signal, repeated cycles can't be shown to
*accelerate* mastery — only to keep adjusting. Closing those two gaps would bring
the implementation in line with the full *Learn → Apply → Reflect → Refine →
Repeat* cycle.

---
---

# Part 2 — Lead Acquisition Intelligence Loop vs. Implementation

**Framework:** *Identify → Acquire → Analyze → Optimize → Repeat*, with the
stated key principle: **data-driven decision-making at each stage to maximize
efficiency / ROI.**

This loop maps far more closely to what ACAOS *is* (a lead-acquisition CRM) than
the generic mastery loop in Part 1. Four of five stages are well-implemented. The
single decisive gap is the framework's explicit **money dimension** — cost,
cost-per-lead, and ROI are **not tracked anywhere**, so "data-driven" decisions
are currently made on win-rate and opportunity score, never on efficiency/ROI.

| Stage | Implemented? | Where | Strength |
|-------|:-----------:|-------|----------|
| **Identify** | ✅ Strong | `WorkspaceICP`, `Mission` (target/offer/playbook) | Rich ICP; channel definition thin |
| **Acquire**  | ✅ Strong | `DiscoveryRun` + `prospectSources` (Apollo/Hunter/Places), `send-campaign` | Outbound only — no ads/content |
| **Analyze**  | ⚠️ Partial | `intelligence/*`, `stats`, source + funnel + reply tracking | **No cost/ROI data** |
| **Optimize** | ⚠️ Partial | `calibrate()` (targeting + messaging), `recommendationPolicy` | No channel/cost optimization |
| **Repeat**   | ⚠️ Partial | `enqueueCalibrate` on outcome | Event-only, no schedule (same gap as Part 1) |

---

## Stage-by-stage

### 1. Identify — *Define ICP and target channels*

**Implementation:** `WorkspaceICP` (`schema.prisma:689`) is a rich, first-class
ICP: `targetIndustries`, `excludedIndustries`, `minEmployees`/`maxEmployees`,
`targetGeos`, `mustHaveEmail`, `businessType`, `outreachTone`, `playbook`.
`Mission` (`schema.prisma:136`) layers intent on top — `targetCustomer`, `offer`,
`playbookId` — as the user-facing control plane.

- ✅ ICP is structured, persisted, and **consumed downstream** by both discovery
  (search input) and scoring (`calcFitScore`, `signalEngine.ts:161`).
- ✅ ICP is also a *learning output* — `calibrate()` rewrites `targetIndustries`
  and the employee band from WON deals (the two loops connect here).
- ⚠️ **"Target channels" is thin.** A channel is chosen *per prospect*
  (`Recommendation.bestChannel` → EMAIL/LINKEDIN/PHONE,
  `signalEngine.ts:278`), but there is no workspace-level channel *strategy*, and
  execution is **email-only** (see Acquire). So channels are described, not
  truly "targeted."

### 2. Acquire — *Run campaigns to generate leads*

**Implementation:** Two acquisition paths:
- **Discovery (inbound sourcing):** `DiscoveryRun` (`schema.prisma:31`) records
  each run's `source`, `query`, `resultCount`, `importedCount`, `skippedCount`,
  status, and errors. Pluggable providers via `prospectSources.ts`
  (Apollo `apps/api/src/services/apollo.ts`, Hunter, Google Places), behind a
  circuit breaker. Quota-guarded (`tests-db/discovery-quota.test.ts`).
- **Outreach (campaign send):** `send-campaign` → `sendCampaignBatch`
  (`processors.ts:237`) generates/reuses drafts and sends via SMTP, with
  suppression checks, daily caps, and at-most-once outbox semantics.

- ✅ Genuinely "runs campaigns" and generates leads, with provenance.
- ✅ Per-run result metrics make acquisition *measurable*.
- ⚠️ **Outbound only.** The framework lists "ads, outreach, content" — ACAOS does
  outreach (and discovery sourcing) but has no ads or content/inbound channel.

### 3. Analyze — *Track source, cost, conversion, engagement*

This stage is **half-built**. Three of four dimensions exist; the money dimension
does not.

- ✅ **Source:** tracked end-to-end — `Lead.sourceTag` (`schema.prisma:172`),
  `DiscoveryRun.source`, `Signal.source`/`sourceUrl`/`sourceReliability`, and
  `EvidenceSource`. Provenance is a genuine strength.
- ✅ **Conversion:** the `LeadStage` funnel (NEW → RESEARCHED → OUTREACH_SENT →
  REPLIED → BOOKED → CLOSED/DEAD) plus `OutcomeStage` (DISCOVERED…WON/LOST) plus
  `intelligence/forecast` (win-probability-weighted pipeline,
  `intelligence.ts:127`) and `intelligence/stats` tier/stage distributions.
- ✅ **Engagement:** `OutreachSent.status`/`repliedAt`/`replyIntent`, reply
  classification (`analyze-reply` → `ScoringOutcome.messageRelevance`,
  `worker.ts:228`).
- ❌ **Cost — absent.** There is **no `cost`/`spend`/`costPerLead`/`CPA`/`ROI`
  field on any model** (verified against `schema.prisma` — `DiscoveryRun` has
  result counts but no cost; AI usage is *metered for limits* via
  `checkAndIncrementAiUsage`/`lib/limits.ts` but never attributed as a
  per-lead/per-source cost). `forecast` reports **revenue**, never **cost or
  net ROI**.

> **This is the defining gap for this framework.** The loop's stated purpose is
> "maximize efficiency/ROI," but the system cannot compute cost-per-lead or ROI by
> source/channel/campaign. Analysis optimizes the numerator (revenue/win rate)
> blind to the denominator (spend).

### 4. Optimize — *Refine targeting, messaging, channels*

**Implementation:** Optimization runs through the Part 1 calibration loop plus the
recommendation policy:
- ✅ **Targeting:** `calibrate()` rewrites ICP industries + employee band from
  WON outcomes (`learningLoop.ts:66-89`).
- ✅ **Messaging:** per-signal `signalWeights` reweight which signals drive
  intent, and `generateRuleBasedRecommendation` maps the dominant signal to a
  message angle (`signalEngine.ts:269`); `recommendationPolicy.evidenceGatedPriority`
  caps un-evidenced "contact now" calls (`worker.ts:361`).
- ❌ **Channels:** not optimized — channel is a static rule from available contact
  info, and sending is email-only, so there is no "which channel converts best"
  feedback.
- ❌ **Cost-based optimization:** impossible today (no cost data, per Analyze).
  Optimization maximizes win rate, not ROI.

### 5. Repeat — *Continuously loop to improve quality and ROI*

Same wiring and same limitation as Part 1: `enqueueCalibrate` re-arms on each
WON/LOST (`prospects.ts:817-819`); no scheduled cadence. For *quality* the loop
does close. For *ROI* it cannot, because the cost half of the equation is never
captured — so "improve ROI" is currently unverifiable.

---

## Concrete gaps & recommended refinements (this loop)

1. **Capture cost (unblocks the whole framework).** Add cost at the point of
   spend: a per-run cost on `DiscoveryRun` (provider credits/$), and an AI/send
   cost attributable per `Lead`/`Campaign`. Without this, stages 3–5 cannot be
   "data-driven on ROI" as the framework requires.
2. **Compute cost-per-lead & ROI by source/channel/campaign.** Extend
   `intelligence/forecast` (or a new `intelligence/economics`) to report CPL, CAC,
   and net ROI alongside the existing revenue forecast — joining `sourceTag` →
   cost → won revenue.
3. **Make channel a first-class, optimizable dimension.** Track channel on sends
   and outcomes, then let calibration/recommendation learn channel performance
   (today it's email-only and statically chosen).
4. **Feed cost back into Optimize.** Once CPL/ROI exist, bias discovery and
   prioritization toward high-ROI sources/segments — not just high win rate.
5. **Scheduled Repeat** (shared with Part 1): add a time-based calibration trigger
   so quality/ROI tuning continues during quiet periods.

---

## Verdict (this loop)

ACAOS implements **Identify, Acquire, Analyze (3/4), and Optimize** as a real,
data-driven lead-acquisition engine — strong on ICP, provenance, conversion, and
outcome-based targeting/messaging refinement. It diverges from the framework on
exactly one axis, but a decisive one: the **cost/ROI dimension is absent**, and
sending/optimization are **single-channel (email)**. The loop today maximizes
*lead quality and win rate*; to match the framework's stated goal of *maximizing
efficiency and ROI*, the missing primitive is **cost capture** — everything else
(CPL, ROI reporting, cost-aware optimization, channel learning) builds on it.

## How the two loops relate

Part 1's calibration loop is the **engine** that powers Part 2's *Optimize* stage.
They share the same WON/LOST trigger, the same `calibrate()` core, and the same
"Repeat has no schedule" limitation. Part 1's weakness (shallow *Reflect* — no
"why") and Part 2's weakness (no *cost/ROI* in *Analyze*) are complementary: both
are about **enriching the data the loop reflects on** before it refines. Adding
(a) a calibration diff/why-trace and (b) cost capture would upgrade both loops at
once.

---
---

# Part 3 — `Opportunity = Prospect + Signal + Evidence` vs. Implementation

**Framework:** A qualified opportunity exists only when all three align:
- **Prospect** — a potential customer/account.
- **Signal** — an indication of interest or need (e.g. website visit, content download).
- **Evidence** — proof of fit, budget, authority, timeline (BANT) (e.g. demo request, discovery call).

**Headline:** ACAOS implements this equation **structurally and literally** —
`Prospect`, `Signal`, and `EvidenceSource` are three separate first-class models,
and "all three must align" is enforced two ways (a geometric-mean score that
collapses if any factor is zero, plus an evidence gate on high-confidence
recommendations). Where it diverges is **semantic**: ACAOS's *Signal* means
third-party **market** signals (not first-party engagement), and its *Evidence*
means **source provenance** (not BANT qualification).

| Term | Modeled? | As | Matches framework meaning? |
|------|:--------:|----|----------------------------|
| **Prospect** | ✅ | `Prospect` (`schema.prisma:496`) | ✅ Exact |
| **Signal**   | ✅ | `Signal` + `SignalType` (`schema.prisma:548`) | ⚠️ Market signals, not engagement |
| **Evidence** | ✅ | `EvidenceSource` (`schema.prisma:581`) + `evidenceGatedPriority` | ⚠️ Provenance proof, not BANT proof |
| **Alignment**| ✅ | geometric mean + evidence gate | ✅ Strong |

---

## Term-by-term

### Prospect — *a potential customer/account*

`Prospect` (`schema.prisma:496`) is an exact match: company identity, firmographics
(`industry`, `employeeCount`, `estimatedRevenue`, `location`), contact
(`contactName/Email/Phone/Title`, `linkedinUrl`), and the derived scores. It owns
`signals[]`, `evidenceSources[]`, `recommendations[]`, and `outcomes[]` — the
equation's left-hand side is a real aggregate root.

### Signal — *an indication of interest or need*

`Signal` (`schema.prisma:548`) is first-class and typed (`SignalType`), with
`strength`, `sourceReliability`, `industryRelevance`, `detectedAt`, and
per-type exponential **decay** (`signalEngine.ts:46`) so stale interest fades.

- ✅ Structurally exactly "an indication of interest/need," and quantified.
- ⚠️ **Semantic divergence.** The framework's examples are *first-party
  engagement* (website visit, content download). ACAOS's signal types are
  *third-party market events* — `FUNDING, HIRING, PROCUREMENT, EXPANSION,
  TECH_ADOPTION, LEADERSHIP_CHANGE, NEWS_MENTION, BUSINESS_REGISTRATION,
  WEBSITE_CHANGE` (`signalEngine.ts:3`). These infer *need*, not first-party
  *interest*.
- ❌ **No first-party engagement signal.** There's no web-analytics / content-
  download / page-visit event feeding the prospect's intent. The one engagement
  signal that *is* captured — email reply intent (`analyze-reply` →
  `ScoringOutcome`, `worker.ts:228`) — flows into the *calibration* loop, not back
  in as a `Signal` on the prospect's opportunity score. So "interest" is
  under-represented relative to "need."

### Evidence — *proof of fit, budget, authority, timeline*

`EvidenceSource` (`schema.prisma:581`) gives every signal provenance: `provider`,
`sourceType` (job_posting | website | news | tender | review), `sourceUrl`,
`confidence` (0..1), `observedAt`, `expiresAt`, `rawText`. A `Signal` links to
its `EvidenceSource` via `evidenceSourceId`.

- ✅ Makes the opportunity **auditable** — every "why now" can answer "what's the
  source?" That's a genuine, well-built evidence layer.
- ⚠️ **Semantic divergence.** The framework's Evidence is **BANT qualification**
  (proof of fit/budget/authority/timeline — demo requests, discovery calls).
  ACAOS's Evidence proves *the signal is real and fresh*, not that the buyer is
  *qualified*. The two map only partially:
  - **Fit** — ✅ covered, but by `fitScore` (Prospect↔ICP, `signalEngine.ts:161`),
    not by `EvidenceSource`.
  - **Authority** — ⚠️ partial: `contactTitle` exists but isn't verified as
    decision-maker authority.
  - **Timeline** — ⚠️ partial: `buyingStage`/`timingScore` infer urgency, but no
    stated buyer timeline.
  - **Budget** — ❌ no budget field; `estimatedRevenue`/`expectedDealValue` are
    firmographic proxies, not proof of available spend.
- ❌ **No qualification-event evidence type.** A demo request or completed
  discovery call (the framework's canonical evidence) has no representation — there's
  no `sourceType` for "sales_interaction"/"meeting," and qualification isn't a
  `BuyingStage` you can prove with an artifact.

### Alignment — *all three must align*

This is the strongest part, enforced **twice**:

1. **Geometric mean (co-presence required).** `calculateOpportunityScores`
   (`signalEngine.ts:197`) computes `opportunityScore = (intent × fit × timing ×
   confidence)^0.25`. Because it's a product, **any factor near zero collapses the
   whole score** — Prospect-fit with no Signal (intent≈0), or Signal with no
   prospect fit, both score low. This is "all three must align" expressed as math.
2. **Evidence gate (proof required for confidence).** `evidenceGatedPriority`
   (`recommendationPolicy.ts:35`) caps any recommendation below the
   high-confidence line (priority 69) **unless at least one signal is backed by an
   EvidenceSource and not EXPIRED** (`hasValidEvidence`,
   `recommendationPolicy.ts:24`). So Prospect + Signal *without* Evidence is
   explicitly **not** allowed to present as a hot, qualified opportunity — exactly
   the framework's "all three must align."

The send track carries the alignment forward: `OutreachIntent.evidenceSnapshot`
and `OutreachSent.evidenceSnapshot`/`recommendationId` (`schema.prisma:229-233`)
snapshot the evidence at send time, so a dispatched opportunity stays auditable.

---

## Concrete gaps & recommended refinements (this equation)

1. **Add first-party engagement signals.** Introduce `SignalType`s for web
   visits / content downloads / email opens-clicks so *interest* (not just market
   *need*) raises intent. Feed reply-engagement back as a prospect `Signal`, not
   only into calibration.
2. **Model BANT as evidence, not just provenance.** Add qualification evidence —
   a `sourceType: "sales_interaction"` (demo request, discovery call) and explicit
   budget/authority/timeline capture — so `Evidence` means *proof of qualification*
   as the framework intends, not only *proof of source*.
3. **Gate "qualified" on real BANT.** Today the evidence gate checks
   *provenance + freshness*. Once BANT evidence exists, extend `hasValidEvidence`
   so "qualified opportunity" requires fit **and** at least one
   budget/authority/timeline artifact — tightening the equation.
4. **Surface the equation explicitly.** The opportunity score blends four
   sub-scores; consider exposing a literal Prospect / Signal / Evidence readiness
   triad in `intelligence/opportunities` so users see *which leg is missing*.

---

## Verdict (this equation)

ACAOS is the **rare system that implements `Opportunity = Prospect + Signal +
Evidence` as three real, separately-modeled primitives with enforced alignment** —
the geometric-mean score and the evidence gate together make "all three must
align" a hard rule, not a slogan. The divergence is one of *meaning*, not
*structure*: its **Signal** leans on third-party *need* rather than first-party
*interest*, and its **Evidence** proves *source provenance* rather than *BANT
qualification*. Adding engagement signals and BANT-style evidence would close the
gap between the equation as coded (real-but-market-flavoured) and the equation as
defined (interest + qualification).

## How all three parts connect

- **Part 3** defines the *unit* the system reasons about (a qualified opportunity).
- **Part 2** is the *acquisition loop* that produces and converts those units.
- **Part 1** is the *learning engine* that tunes how units are scored from outcomes.

Their gaps rhyme: Part 1 wants a richer *Reflect* (why a weight moved), Part 2
wants *cost/ROI* data, Part 3 wants richer *Signal* (engagement) and *Evidence*
(BANT). All three are fundamentally **"capture more/better data so the system can
reason and learn on it"** — the engine, loops, and primitives are sound; the
highest-leverage work is enriching their inputs.

---
---

# Part 4 — Recommendation Layer ("operator brain") vs. Implementation

**Framework:** A layer that decides the next action for each prospect and outputs
clear, actionable moves — *Contact now · Wait · Enrich contact first · Send
follow-up · Suppress · Re-engage · Assign to campaign · Create draft · Escalate as
high-intent opportunity* — so it feels like *"Here are the moves I'd make today."*

**Headline:** This layer **exists and is central** to ACAOS — it is exactly the
`Recommendation` → `OutreachIntent` spine, surfaced as a daily action queue. The
gap is **expressiveness**: the system produces a *single best-action bundle per
prospect* (text + timing + urgency + priority), not a **typed decision across an
enumerable move set**. About half the framework's nine moves are first-class; the
rest exist only as side mechanisms (suppression, campaign assignment) or not at
all (re-engage).

| Framework move | Status | How it's expressed today |
|----------------|:------:|--------------------------|
| **Contact now** | ✅ | `urgency: HIGH` + priority ≥ 70 + "Today — signal is very fresh" |
| **Wait** | ✅ | `urgency: LOW` + "prioritize other hot prospects" / `INACTIVE: 'Monitor for new signals'` |
| **Enrich contact first** | ✅ | `evidenceGatedPriority` caps to 69 ("enrich before hot") + `POST /:id/enrich` |
| **Create draft** | ✅ | `POST /:id/intents/:intentId/draft` (+ `generate-outreach`) |
| **Escalate as high-intent** | ✅ | HOT tier (≥72) + `AUTO_RECOMMEND_THRESHOLD` auto-generates a recommendation |
| **Send follow-up** | ⚠️ | `followup` *content* always generated, but never a discrete "send follow-up now" move |
| **Suppress** | ⚠️ | `Suppression` model + send-time filter exist as a *mechanism*, not a recommended move |
| **Assign to campaign** | ⚠️ | `materialize` → lead/campaign + mission spine exist, but not phrased as a recommendation |
| **Re-engage** | ❌ | no discrete re-engage move (trajectory is computed but not actioned) |

---

## What's actually there

The "operator brain" is real and well-wired:

- **Decision core:** `generateRuleBasedRecommendation` (`signalEngine.ts:269`)
  turns a prospect's dominant signal into `bestContact`, `bestTiming`,
  `bestChannel`, `messageAngle`, `reasoning`, `actionText`, `urgency`, `priority`.
- **Trust gate:** `evidenceGatedPriority` (`recommendationPolicy.ts:35`) holds back
  any "contact now" the evidence can't back up.
- **Production:** the `generate-recommendations` worker (`worker.ts:318`) creates
  one `Recommendation` per qualifying prospect, **deduped** (skip if a recent
  un-acted one exists, `worker.ts:332`) and **TTL'd** (`expiresAt` +7d) — so the
  brain doesn't spam the radar.
- **Hand-off:** every recommendation spawns an `OutreachIntent`
  (`outreachIntent.ts:33`) that carries it through `PROPOSED → DRAFTED → APPROVED →
  QUEUED → SENT → WON/LOST/REJECTED` — the moves are *executable*, not just advice.
- **The "today" surface:** `GET /api/prospects/intents` ("this week's outreach",
  `prospects.ts:252`) and the mission action queue (`missions.ts:143`) list
  actionable intents, strongest opportunity first — literally *"here are the moves
  I'd make today."*

So the framework's *intent* — a decisive, surfaced, executable operator brain — is
implemented. The shortfall is in the **shape of the output**.

## Where it diverges

1. **No typed move vocabulary.** The framework names nine discrete moves; the
   `Recommendation` model (`schema.prisma:602`) has no `nextAction`/`moveType`
   enum. "Contact now" vs "Wait" is *inferred* from `urgency` + `priority` +
   free-text `bestTiming`, not declared. Consumers can't filter/route by move, and
   the brain can't say "the move here is **Suppress**."
2. **Moves that exist only as mechanisms.** *Suppress* (`Suppression` + send
   filter) and *Assign to campaign* (`materialize` → lead/campaign) are real
   capabilities, but the brain never *recommends* them — they're operator-initiated
   side doors, not proposed moves.
3. **Send follow-up is content, not a decision.** A `followup` body is always
   generated, but nothing decides *"no reply after N days → recommend the
   follow-up now."* The timing decision is missing.
4. **Re-engage is absent.** `predictBuyingIntent` computes an ACCELERATING/
   DECELERATING trajectory (`signalEngine.ts:364`) and signals decay, but no move
   says *"this dormant prospect's signals refreshed — re-engage."*
5. **One move per prospect.** The brain emits a single best action; the framework
   implies a richer per-prospect decision (which of the nine, possibly more than
   one). Today "Enrich first" and "Create draft" can't both be queued moves.

---

## Concrete gaps & recommended refinements (this layer)

1. **Add a typed `nextAction` enum** to `Recommendation` —
   `{ CONTACT_NOW, WAIT, ENRICH, SEND_FOLLOWUP, SUPPRESS, RE_ENGAGE,
   ASSIGN_TO_CAMPAIGN, CREATE_DRAFT, ESCALATE }` — derived in
   `generateRuleBasedRecommendation` from the same inputs it already uses
   (urgency/priority/evidence/freshness). Low effort, high clarity; everything
   downstream can route on it.
2. **Promote the side-door moves to recommendations.** Let the brain *propose*
   Suppress (repeated non-engagement/bounce), Assign-to-campaign (qualified +
   unassigned), and Re-engage (decayed-then-refreshed signals) — each mapping to
   the API action that already exists.
3. **Make follow-up a timed decision.** When an `OutreachSent` has no reply after
   a threshold, emit a `SEND_FOLLOWUP` move (the content is already generated).
4. **Allow >1 move per prospect** (or an ordered move list) so "enrich → then
   draft" reads as a plan, matching "the moves I'd make today."

---

## Verdict (this layer)

The operator brain is **present, trustworthy, and executable** — recommendation
generation, the evidence gate, dedup/TTL, the intent lifecycle, and the daily
action queue together deliver the framework's core promise. It falls short on
**vocabulary breadth**: it speaks ~5 of the 9 moves fluently, expresses a few
others only as mechanisms, and can't yet say "Suppress / Re-engage / Send
follow-up now" as decisions. Adding a typed move enum and wiring the missing moves
to their existing API actions would turn a strong single-action recommender into
the full nine-move operator brain the framework describes.

## How Part 4 fits with the rest

Part 4 is the **decision/output layer** sitting on top of everything prior: it
consumes the Part 3 opportunity (Prospect + Signal + Evidence), is the actuator
for Part 2's *Acquire/Optimize* stages, and its `actedAt`/outcome results are the
WON/LOST events that feed Part 1's learning loop. Its gap is consistent with the
through-line: the brain's *reasoning is sound but its expressed vocabulary is
narrower than the model underneath supports* — same pattern as Part 1's thin
Reflect, Part 2's missing cost, and Part 3's market-flavoured signals. The
infrastructure is built; the leverage is in **letting each layer say everything it
already almost knows.**

---
---

# Part 5 — Approval / Safety Layer vs. Implementation

**Framework:** A trust & compliance layer that prevents reckless email blasting via:
draft approval workflows · unsubscribe suppression · domain sending limits &
workspace quotas · duplicate & contact suppression · compliance checks & tone
guardrails · evidence-required sending · fail-closed send queue — making ACAOS
safe for real business use.

**Headline:** This is the **most fully-realized** of the five frameworks — safety
is visibly a first-class design priority, not an afterthought. Four of the seven
controls are strong and production-grade; three are partial, and the partials are
the most security-relevant gaps to know about: **per-domain sending limits**, **tone/
content guardrails as actual checks**, and **evidence as a hard send precondition**
(today it gates *recommendations* and is *recorded* at send, but does not *block* a
send).

| Control | Status | Where |
|---------|:------:|-------|
| **Draft approval workflows** | ✅ Strong | `approvalMode` + intent `approve/reject` + RBAC + audit |
| **Unsubscribe suppression** | ✅ Strong | footer token → `/unsubscribe/:token` → `suppress()` → pre-send filter |
| **Duplicate & contact suppression** | ✅ Strong | outbox `@@unique([campaignId, leadId])` + `Suppression` + fingerprints |
| **Fail-closed send queue** | ✅ Strong | SENDING-before-SMTP outbox; crash/error never auto-resends |
| **Domain limits & workspace quotas** | ⚠️ Partial | workspace/daily/plan quotas ✅; **per-domain limit ❌** |
| **Compliance checks & tone guardrails** | ⚠️ Partial | CAN-SPAM footer ✅; tone is an *input*, no content *check* |
| **Evidence-required sending** | ⚠️ Partial | gates recommendations + stamped at send; **not a send precondition** |

---

## Control-by-control

### Draft approval workflows — ✅

`WorkspaceICP.approvalMode` defaults to **true** (`schema.prisma:699`). When on,
`sendCampaignBatch` only includes `status: 'APPROVED'` drafts
(`processors.ts:277`), so an unapproved lead is silently skipped rather than
mailed. The intent track adds an explicit human gate: `approve`/`reject`
(`prospects.ts:946`, `:971`) are **admin-gated** (`assertMinimumWorkspaceRole
'admin'`) and **audit-logged** (`recordAudit`). Approval locks the evidence + text
snapshot. Strong and human-in-the-loop by default.

### Unsubscribe suppression — ✅

Every send embeds a unique `unsubscribeToken` and a footer link
(`processors.ts:402-409`). The **public, no-auth** `/unsubscribe/:token`
(`unsubscribe.ts:12`) calls `suppress(..., 'UNSUBSCRIBED')`. Before any send,
`bulkCheckSuppression` (`processors.ts:299`) filters the whole recipient list, and
each lead is re-checked (`processors.ts:341`). Bounces also suppress. Closed loop.

### Duplicate & contact suppression — ✅

- **Duplicate:** the outbox `@@unique([campaignId, leadId])` (`schema.prisma:246`)
  is the hard guarantee of at-most-once per lead per campaign; a racing/retrying
  attempt hits a P2002 and skips (`processors.ts:441`). A cheap pre-check also
  skips already-SENT/SENDING/FAILED rows. Signal `fingerprint` dedups evidence;
  recommendations dedup on recency.
- **Contact:** the `Suppression` model + `isSuppressed`/`bulkCheckSuppression`.
- ⚠️ Minor: dedup is **per campaign** — the same address in two campaigns is not
  globally deduped (NULLs distinct in the unique index).

### Fail-closed send queue — ✅

Genuine outbox pattern (`processors.ts:412-476`): a `SENDING` row is claimed
**before** the SMTP call. A crash *after* dispatch leaves the row `SENDING`
(never auto-resent); a known SMTP rejection → `FAILED` with `lastError` for
operator review (not auto-retried). Mission `PAUSED`/`COMPLETE` is an operator
stop button re-checked **before each lead** (`processors.ts:321`). Defaults to not
sending when uncertain — textbook fail-closed.

### Domain sending limits & workspace quotas — ⚠️

- **Workspace quotas — ✅ strong:** `dailySendLimit` (default 50, per workspace)
  enforced mid-batch (`processors.ts:284-294`); monthly AI-call, discovery, and
  lead caps per plan, all **advisory-locked** against check-then-increment races
  (`limits.ts:49-148`).
- **Domain sending limits — ❌ missing:** there is no per-**recipient-domain**
  throttle (e.g. max N/day to one company) and no per-**sending-domain**
  reputation cap. The only rate control is the flat workspace daily limit. For a
  field-service CRM this is lower-risk, but it's the one named control with no
  implementation.

### Compliance checks & tone guardrails — ⚠️

- **Compliance — ✅ for CAN-SPAM/GDPR basics:** every email carries an unsubscribe
  link plus, when configured, sender business name + physical postal address
  (`processors.ts:405-409`). HTML is escaped (anti-injection). (Out of band: SMTP
  host SSRF protection, per recent hardening.)
- **Tone guardrails — ⚠️ input, not a check:** `outreachTone`
  (professional/casual/direct) is *passed to* the generator as a preference
  (`prospects.ts:924`), but nothing **validates or blocks** the generated copy —
  no content moderation, banned-phrase scan, or compliance lint on the output. A
  guardrail names a limit and enforces it; today tone is a suggestion, not a gate.

### Evidence-required sending — ⚠️

This is the subtlest gap. Evidence is enforced at the **recommendation** layer
(`evidenceGatedPriority`, `recommendationPolicy.ts:35`) — an un-evidenced
opportunity can't present as "contact now." At **send** time, the evidence
snapshot is **stamped onto** `OutreachSent`/`OutreachIntent` for auditability
(`processors.ts:419-435`), but `sendCampaignBatch` does **not require** evidence to
send — an APPROVED draft or eligible lead sends regardless. So evidence is a
*prioritization gate and an audit record*, **not a hard precondition for
dispatch**. The framework's "evidence-required sending" is therefore aspirational
in the strict sense: present as provenance, absent as a blocker.

---

## Concrete gaps & recommended refinements (this layer)

1. **Add per-domain send throttling.** Cap sends per recipient domain per
   day/window (and optionally per sending domain) — the one named control with no
   backing. Slot it beside the existing `dailySendLimit` check.
2. **Turn tone into a real guardrail.** Add a pre-send content check (banned
   phrases, missing-unsubscribe lint, tone classifier) that can **block** a draft,
   not just flavor it. Pairs naturally with the existing approval gate.
3. **Make evidence a send precondition (opt-in).** Add a workspace policy
   (e.g. `requireEvidenceToSend`) so that, when on, `sendCampaignBatch` refuses to
   dispatch a lead/intent without fresh, sourced evidence — closing the gap between
   "evidence recorded" and "evidence required."
4. **Optional cross-campaign contact dedup.** A workspace-level "don't email the
   same address twice within N days across campaigns" policy on top of the
   per-campaign unique.

---

## Verdict (this layer)

The Approval/Safety layer is **the strongest-implemented framework of the five** —
human-in-the-loop approval, unsubscribe/suppression, hard duplicate prevention,
and a genuinely fail-closed outbox are all production-grade, and the system is
plausibly "safe for real business use" today. The honest gaps are narrow but worth
naming: **no per-domain throttle**, **tone/compliance is shaped but not enforced as
a check**, and **evidence is recorded at send rather than required**. None
undermine the core safety posture; each would harden a layer that is already the
project's most mature.

## How Part 5 fits with the rest

Part 5 is the **guardrail around Part 4's actions** — it constrains which of the
operator brain's moves may actually fire, gating the Part 2 *Acquire* send path and
deciding what reaches a prospect. Its strength is the inverse of the through-line:
where Parts 1–4 are "the model knows more than the layer expresses," **safety is
the one area where ACAOS enforces more than it advertises** (defaults to approval,
fails closed, suppresses aggressively). The remaining work — domain limits, tone
*checks*, evidence as a *requirement* — is about making the last three named
guarantees as real as the first four already are.

---
---

# Part 6 — Post-Send Engagement Monitoring vs. Implementation

**Framework:** ACAOS monitors post-send engagement — *opens, clicks, replies,
bounces, unsubscribes, meeting interest, positive/negative replies, no response,
and timing* — and this feedback loop enables adaptive optimization.

**Headline:** ACAOS monitors the **inbound / server-side** engagement signals
thoroughly — replies, bounces, unsubscribes, and AI-classified positive/negative
intent — and genuinely feeds them into adaptive optimization. It does **not**
capture the **client-side tracking** signals (opens, clicks), does not track
**no-response** as a state, and treats **meeting interest** as a manual stage and
**timing** as derivable-but-unused. The opens/clicks absence reads as a deliberate,
privacy/deliverability-conscious choice (consistent with Part 5's safety posture),
but it does narrow the engagement surface the optimizer can learn from.

| Signal | Status | Where |
|--------|:------:|-------|
| **Replies** | ✅ Strong | IMAP `syncMailboxOnce` matches Message-ID → `REPLIED` + `repliedAt` + `analyze-reply` |
| **Bounces** | ✅ Strong | `detectBounceRecipients` (NDR) → `BOUNCED` + `suppress('BOUNCED')` + audit |
| **Unsubscribes** | ✅ Strong | footer token → `/unsubscribe` → `suppress('UNSUBSCRIBED')` |
| **Positive/negative replies** | ✅ Strong | `analyze-reply` classifies intent → `replyIntent` (+ auto-reply detection) |
| **Meeting interest** | ⚠️ Partial | `BOOKED`/`MEETING` stages exist but are **set manually**, not auto-detected |
| **Timing** | ⚠️ Partial | `sentAt`/`repliedAt` captured → latency *derivable*, but not analyzed or fed back |
| **Opens** | ❌ Missing | no tracking pixel / `openedAt` |
| **Clicks** | ❌ Missing | no link-wrapping / click tracking (except the unsubscribe link) |
| **No response** | ❌ Missing | no "no reply after N days" state or detection |

---

## Signal-by-signal

### Replies — ✅

`syncMailboxOnce` (`mail.ts:184`) pulls the mailbox, matches inbound mail to a
prior send by **Message-ID**, marks the `OutreachSent` row `REPLIED` with
`repliedAt` (`mail.ts:171`), advances the lead to `REPLIED`, and enqueues
`analyze-reply`. De-duplicated by processed Message-IDs. This is the backbone of
the whole monitoring loop and it's solid (repeatable every 10 min via the
scheduler).

### Bounces — ✅

`detectBounceRecipients` (permissive NDR detection by sender/subject/body,
`mail.ts:262`) marks the affected `OutreachSent` rows `BOUNCED`, **suppresses only
the addresses that actually bounced** (`mail.ts:292`, an explicit safety
invariant), and audit-logs `email.bounced`. Bounces are reported in campaign/mission
stats and feed suppression — a clean negative-engagement loop.

### Unsubscribes — ✅

Covered in Part 5: the footer token → public `/unsubscribe/:token` → `suppress`.
A first-class, honored negative signal.

### Positive / negative replies — ✅

`analyze-reply` (`worker.ts:162`) classifies each genuine reply —
`INTERESTED / NOT_INTERESTED / NEEDS_MORE_INFO / NOT_NOW / REFERRAL /
OUT_OF_OFFICE` — with auto-reply detection so OOO/autoresponders don't pollute the
signal. The classification maps to a `replyIntent` and a lead-stage transition,
and (the adaptive part) writes a `ScoringOutcome` with `messageRelevance`. This is
the positive/negative axis, done well.

### Meeting interest — ⚠️

The vocabulary exists — `LeadStage.BOOKED` (`schema.prisma:479`) and
`OutcomeStage.MEETING` (`schema.prisma:424`) — but it is **operator-set**, not
auto-detected from a reply. `analyze-reply` can classify `INTERESTED` but doesn't
recognise "let's book a call" as a distinct meeting-interest signal or advance to
`BOOKED`. So meeting interest is *recorded* when a human marks it, not *monitored*.

### Timing — ⚠️

Both `sentAt` and `repliedAt` are stored, so **reply latency is fully derivable**,
and `pilot-results.mjs` already prints recent reply timestamps. But nothing
**computes** time-to-reply, best-send-window, or reply-velocity, and no timing
feature feeds optimization. (The engine's `timingScore` is about *signal
freshness*, not *engagement timing* — a different thing.) The data is there; the
analysis isn't.

### Opens & Clicks — ❌

There is **no open tracking** (no pixel, no `openedAt` column) and **no click
tracking** (links aren't wrapped/redirected; only the unsubscribe link is a
trackable click, and it's used for suppression, not engagement). These are the two
classic email-engagement signals and they are entirely absent.

> **Worth framing fairly:** their absence is plausibly **intentional**. Open-pixels
> and click-wrapping hurt deliverability and raise GDPR/ePrivacy consent questions —
> avoiding them is consistent with ACAOS's safety-first, deliverability-conscious
> design (Part 5). But it does mean the optimizer is blind to *soft* engagement and
> only sees *hard* signals (reply/bounce/unsubscribe).

### No response — ❌

A send with no reply simply stays `SENT`. There's no "no response after N days"
state, no derived non-engagement signal, and so no trigger for a follow-up or a
suppress/de-prioritize decision. This connects to Part 4's missing *Send follow-up*
and *Re-engage* moves — all three need the same primitive: a **time-since-send,
no-reply** detector.

## Does the feedback loop drive adaptive optimization?

**Partially, and genuinely for the signals it captures.** Replies flow into two
adaptive paths:
1. **Per-reply weight recalibration** — `analyze-reply`/outcomes write
   `ScoringOutcome`, and `outcomes.ts:227-231` recomputes scoring weights **every
   7 outcomes**.
2. **Outcome calibration** — WON/LOST (often downstream of a positive reply) drive
   the Part 1 `calibrate()` loop.

So the framework's claim is **true for hard signals** (reply intent, win/loss). It
is **not** true for opens/clicks/no-response/timing, because those aren't captured
— the optimizer can't adapt to engagement it never sees.

---

## Concrete gaps & recommended refinements (this monitoring)

1. **Add a no-response detector (highest leverage).** A scheduled sweep flags
   `OutreachSent` with no `repliedAt` after N days → emits the non-engagement
   signal that unlocks Part 4's *Send follow-up* and *Re-engage* moves.
2. **Auto-detect meeting interest.** Extend `analyze-reply` to recognise
   scheduling intent ("happy to chat", "book a time") and advance to `BOOKED` /
   surface it — turning a manual stage into a monitored signal.
3. **Compute timing features.** Derive time-to-reply and best-send-window from the
   `sentAt`/`repliedAt` already stored, and feed them into send scheduling /
   optimization.
4. **(Optional, privacy-gated) opens/clicks.** If/when desired, add consent-gated
   open/click tracking — but treat the current omission as a defensible
   deliverability/privacy stance, not an oversight.

---

## Verdict (this monitoring)

ACAOS's post-send monitoring is **strong on hard, consent-safe signals** —
replies, bounces, unsubscribes, and AI-classified positive/negative intent are all
captured and (for replies/outcomes) genuinely feed adaptive optimization. The
framework overstates current coverage in three places: **opens and clicks aren't
tracked at all** (plausibly by design), **no-response isn't a monitored state**,
and **meeting interest/timing are recorded-or-derivable but not auto-detected or
analyzed**. The single highest-leverage addition is a **no-response/timing
detector**, because it simultaneously completes this monitoring loop *and* unlocks
the missing operator-brain moves in Part 4.

## How Part 6 fits with the rest

Part 6 is the **sensor array** that closes the cycle: it observes what happens
*after* Part 4 acts and Part 5 permits, and it is the chief supplier of the
"interest" signals Part 3 wanted and the reply-engagement data Part 1 learns from.
The through-line holds once more — the captured signals are wired through to
learning, but the **uncaptured ones (no-response, timing, soft engagement) are
exactly the inputs whose absence limits every downstream layer.** Enriching the
sensors is, again, the highest-leverage move.

---
---

# Part 7 — The Full 14-Layer Acquisition Intelligence Stack (Capstone)

**Framework:** ACAOS as a stacked Acquisition Intelligence Engine —
*Mission Control → Radar → Prospect Intelligence → Signal Detection → Evidence →
Scoring → Opportunity → Recommendation → Outreach Generation → Approval/Safety →
Execution → Engagement → Reply Classification → Learning* — where **every layer
makes the next one smarter**, and the positioning is *"AI finds revenue moments,
proves why they matter, recommends the next move, drafts the outreach, and learns
from every result"* — not "AI writes sales emails."

**Headline:** This is the master architecture that subsumes Parts 1–6, and the
honest finding is striking: **ACAOS genuinely is this layered system, not an
email-writer with a wrapper.** All 14 layers exist as real, traceable code, and
the canonical spine runs end-to-end — `OutreachIntent` literally carries an
opportunity from evidence → draft → approval → send → outcome as one auditable
record. The maturity is a **gradient**: the *middle* of the stack
(Prospect → Evidence → Scoring → Opportunity → Outreach → Approval → Execution) is
production-grade; the *edges* are thinner — the **input edge** (autonomous radar
feeds, continuous signal detection) and the **top + learning edge** (full mission
autonomy, rich learning) are where the work remains.

## 14-layer scorecard

| # | Layer | Status | Where / note (✅ deep-dived in linked Part) |
|---|-------|:------:|---------------------------------------------|
| 14 | **Mission / Orchestration** | ⚠️ Partial | `Mission` + `Campaign` control plane (`missions.ts`); playbook/discovery/recs wired, **but not a fully autonomous agent** — steps are operator-driven + human approval by design |
| 1 | **Radar / Source** | ⚠️ Partial | 4 live providers — `google_places`, `apollo`, `hunter`, `csv` (`prospectSources.ts:222`); permits/tenders/job-feeds/directories are **future** |
| 2 | **Prospect Intelligence** | ✅ Strong | `Prospect` + Apollo `enrich` + `research-lead` AI (industry/size/location/ICP fit/decision-makers) |
| 3 | **Signal Detection** | ⚠️ Partial | 9 `SignalType`s + unified `ingestSignal` (`signalIngest.ts`); feeds are **enrichment/import, not autonomous monitoring** |
| 4 | **Evidence Ledger** | ✅ Strong | `EvidenceSource`: source/timestamp/confidence/type/text/url *(Part 3)* |
| 5 | **Scoring Engine** | ✅ Strong | 4-factor geometric mean + learned weights (`signalEngine.ts`) *(Part 3)* |
| 6 | **Opportunity Engine** | ✅ Strong | `opportunityScore` + `buyingStage` + `winProbability`; Prospect+Signal+Evidence aligned *(Part 3)* |
| 7 | **Recommendation Engine** | ⚠️ Partial | exists + evidence-gated + executable; **narrow move vocabulary** *(Part 4)* |
| 8 | **Outreach Generation** | ✅ Strong | grounded `generateOutreach` + **draft-from-evidence** (`buildIntentDraftInput`); mostly email format |
| 9 | **Approval / Safety** | ✅ Strong | strongest layer — approval default-on, fail-closed *(Part 5)* |
| 10 | **Execution / Send** | ✅ Strong | outbox, retry/fail semantics, metering, suppression *(Part 5)* |
| 11 | **Engagement** | ⚠️ Partial | hard signals only — no opens/clicks/no-response *(Part 6)* |
| 12 | **Reply Classification** | ⚠️ Partial | 6 classes + auto-reply; **~half the taxonomy + no follow-up task** (below) |
| 13 | **Learning Loop** | ⚠️ Partial | works; thin *Reflect*, narrow inputs *(Part 1)* |

**Tally:** 7 Strong ✅ · 7 Partial ⚠️ · 0 Absent. *Every layer is present* — the
gradient is in depth, not existence.

## Notes on the layers not deep-dived earlier

- **Mission / Orchestration (14):** `POST /missions` creates a mission **and** its
  execution campaign in one transaction (`missions.ts:163`), with status control
  (`ACTIVE/PAUSED/COMPLETE`) that the send path honors. Discovery, scoring, and
  recommendations are *wired into* the control plane and partially auto-advance
  (score → recommend → intent). What's **not** there is the framework's "type one
  goal → it autonomously runs all 10 steps": today the human drives the steps and
  approval is a deliberate gate (Part 5). It's an orchestration **scaffold with
  human-in-the-loop**, not an autonomous agent — arguably the right default for a
  safety-first product, but short of the "AI operating system" vision.

- **Radar / Source (1):** Real, pluggable provider abstraction
  (`ProspectSourceProvider`) with 4 configured sources and a circuit breaker. The
  framework's richer feed list (permit/licence, tenders/RFPs, job postings as
  *live feeds*, directories) maps to existing `SignalType`s (`PROCUREMENT`,
  `HIRING`, `BUSINESS_REGISTRATION`, `WEBSITE_CHANGE`) but has **no automated
  collector** — those signals must be imported. So the *schema anticipates* the
  radar; the *crawlers* are future.

- **Signal Detection (3):** Unified, idempotent `ingestSignal` with fingerprint
  dedup and mandatory evidence linkage — architecturally exactly right. The gap is
  *autonomy*: detection happens on enrichment/import, not via continuous market
  monitoring, so "detect something changed *before* competitors" depends on how
  fresh the (currently manual/enrichment-driven) inputs are.

- **Outreach Generation (8):** Genuinely **grounded**, not generic —
  `buildIntentDraftInput` (`outreachIntent.ts:64`) feeds the recommendation's
  *reasoning* and the signal-derived *angle* into the draft, and pulls industry
  from the prospect (never the seller's ICP). This is the framework's "message
  grounded in the signal," implemented. It's email-shaped (subject/email/followup);
  LinkedIn/call-note formats are angles, not distinct generators.

- **Reply Classification (12):** `analyze-reply` returns
  `INTERESTED / NOT_INTERESTED / NEEDS_MORE_INFO / NOT_NOW / REFERRAL /
  OUT_OF_OFFICE` + `isAutoReply`. Against the framework's taxonomy it covers
  interested / not-interested / later / referral / (unsubscribe via suppression),
  but **misses wrong-person, objection, meeting-request, pricing-question, and an
  explicit active-opportunity class** — and crucially, the framework's own example
  ("we might need this in August, send info" → *create a late-July follow-up
  task*) **can't happen: there is no task/tickler entity**, so a "later" reply is
  classified but not *scheduled*. This is the same missing primitive as Part 6's
  no-response and Part 4's re-engage: **time-based follow-up**.

## The canonical spine — is it real?

**Yes, and it's the strongest evidence ACAOS is the layered system it claims.**
The framework's product spine —

> Prospect + Signal + Evidence → Opportunity → Recommendation → Outreach Intent →
> Draft → Approval → Send → Engagement → Learning Update

— is implemented as one **traceable, auditable path**: `Prospect`/`Signal`/
`EvidenceSource` → `opportunityScore` → `Recommendation` → `OutreachIntent`
(carrying an `evidenceSnapshot`) → `draft` → `approve` → `materialize`/`send`
(stamping provenance onto `OutreachSent`) → reply/bounce monitoring → `ScoringOutcome`/
`calibrate`. The intent record is the connective tissue the framework describes,
and it exists.

## Positioning verdict

The framework's central claim — *don't position this as "AI writes sales emails";
position it as a layered intelligence system that finds revenue moments, proves
them, recommends the move, drafts grounded outreach, and learns* — is **already
true of the codebase**, not aspirational marketing. The copywriting layer (8)
deliberately sits *after* evidence (4) and scoring (5), exactly as prescribed, and
nothing fires without provenance attached. ACAOS earns the stronger positioning.

Where reality is softer than the pitch: the **autonomy** ("type a mission, it runs
everything") and the **breadth of inputs/feedback** (radar feeds, soft engagement,
full reply taxonomy, follow-up scheduling, rich learning). These are depth gaps in
a real stack — not missing layers.

---

# Overall synthesis (Parts 1–7)

Across six sub-frameworks and the full stack, **one pattern holds at every layer**:

> The architecture, schema, and connective spine are genuinely built and correct.
> The consistent gap is **input/expressive richness** — each layer reasons well but
> sees or says less than the model beneath it could support.

- **Part 1 (Learning):** loop closes, but *Reflect* is shallow (no "why").
- **Part 2 (Acquisition):** loop runs, but *cost/ROI* is uncaptured.
- **Part 3 (Opportunity):** equation is enforced, but *Signal*=market not interest, *Evidence*=provenance not BANT.
- **Part 4 (Recommendation):** brain is executable, but speaks ~5 of 9 moves.
- **Part 5 (Safety):** the inverse — *enforces more than it advertises* (the mature exception).
- **Part 6 (Engagement):** hard signals wired, soft signals (opens/clicks/no-response/timing) absent.
- **Part 7 (Full stack):** all 14 layers exist; strong middle, thinner input + orchestration edges.

**The three highest-leverage, cross-cutting investments** (each unlocks multiple
layers at once):

1. **A time-based follow-up / no-response primitive** — unlocks Part 4 (Send
   follow-up, Re-engage), Part 6 (no-response), and Part 12 (schedule the "later"
   reply). One small scheduler, four gaps closed.
2. **Cost capture** — unlocks Part 2's entire ROI half and cost-aware optimization.
3. **Richer feedback into learning** — a calibration "why" trace (Part 1) + feeding
   reply/engagement signals back as first-class inputs (Parts 3, 6) — so *Repeat*
   provably *accelerates*, not just *continues*.

**Bottom line:** ACAOS is not "AI email writing." It is a real, end-to-end layered
acquisition-intelligence system with a sound spine and a safety-first spine-guard.
Its frontier is not building missing layers — it's **enriching the data each
existing layer reasons on**, so the compounding system the architecture promises
actually compounds.
