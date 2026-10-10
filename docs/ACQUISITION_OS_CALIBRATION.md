# Acquisition OS — signal calibration (phase 12)

This phase works out which commercial events actually turn into revenue and
weights them to match. A human approves every weight before scoring uses it.

| Code | What |
|---|---|
| `lib/signalCalibration.ts` | Pure: the funnel per kind, combination lift and bounded weights |
| `lib/calibrationLearning.ts` | Loaders, `loadCalibration` and `learnSignalCalibration` (the proposal) |
| `lib/opportunityScoring.ts` | Applies the approved weight to probability (`scorecard.calibration`) |
| `lib/learningDecisions.ts` | The `EVENT_KIND_WEIGHT` type: stale-safe approve and revert |
| `ScoringModel.eventKindWeights` | Approved weights. A new nullable column (additive migration). |
| `GET /api/commercial-opportunities/calibration` | The report, current weights and what would be proposed now |

## The report

The report is built from the outcome chains (phase 10) and the commercial events
detected at each company.

**Funnel per event kind:**
- opportunities → conversations (a reply or a meeting) → quotes → closed → won →
  revenue
- the conversation rate (out of opportunities)
- the win rate (out of closed opportunities)
- the **adjusted** win rate: shrunk toward the workspace baseline with 5
  pseudocounts, so a lucky 3/3 doesn't read as 100%

**Combination lift.** The base kind together with the other kinds present at the
company when it closed, against the base kind alone. Both are shrunk, and both
need at least 5 closed outcomes. For example, "hiring surge + new project +
capacity expansion wins 2.1× as often as a hiring surge alone".

## Weights

For each kind with at least 5 closed outcomes, the weight is the adjusted win rate
divided by the baseline. It is clamped to 0.5–1.5 and rounded to 2 places.
- Nothing is proposed until there is at least one win to learn from.
- A kind below the sample bar keeps its approved weight. Without one it stays at 1,
  which is neutral.
- Scoring multiplies the opportunity's probability by the weight, capped at 1.
  Expected value and priority follow from probability.
- `scorecard.calibration` records the weight and the reason, for example "tender
  opportunity has outperformed in this workspace (×1.3)".

## Approval, never automatic

- **The proposal.** `learnSignalCalibration` runs in the worker's calibrate-scoring
  job, best-effort. It writes one `EVENT_KIND_WEIGHT` LearningRecommendation:
  - `currentValue`: the live weights
  - `proposedValue`: the live weights merged with the newly learned ones
  - `evidence`: the funnels, the top 10 combinations and `heldOut` (below)

  The proposal is PENDING in every mode, **`live` included**. `off` does nothing.
  An identical PENDING proposal is kept, and a changed one is superseded. One
  without `heldOut` (made before UQ-29) is superseded even when unchanged.
- **Held-out test (UQ-29).** `evaluateEventKindWeights` orders the dated closed
  outcomes by close date and holds back the newest 30% (at least 10). It fits
  weights on the older outcomes only, then scores the live weights and those
  candidate weights on the same held-back outcomes. Each predicts win probability
  as the older outcomes' win rate × the kind's weight.
  - Metrics: Brier error (calibration) and pairwise AUC (ranking).
  - `IMPROVED`: Brier error drops by more than 0.002 and AUC falls by no more
    than 0.02.
  - `DEGRADED`: Brier error rises by more than 0.002, or AUC falls further.
  - `NO_IMPROVEMENT`: anything in between.
  - `INSUFFICIENT`: fewer than 20 dated closed outcomes, or the older ones
    support no change.
- **Approve.** This writes the weights only if the verdict is `IMPROVED` and the
  live weights still equal `currentValue`; otherwise it returns 409. The Learning
  Centre shows the verdict and disables Accept unless it is `IMPROVED`. It's
  audited and expires like other proposals.
- **Revert.** This restores `currentValue` only if the live weights still equal what
  was approved.

## Caveat: feedback loop

Approved weights change which opportunities get worked first. Later outcomes then
partly reflect that choice. The shrinkage and the 0.5–1.5 bounds limit the
drift, and every change needs a human. Still, read a run of approvals in the same
direction with that in mind.

## Next

Phase 13 is cross-customer intelligence: aggregated and anonymised only.
