# Acquisition OS — Opportunity Scoring 2.0

Plan phase 6. One generic 0–100 lead score is replaced by a **scorecard of independent
dimensions**, each with a one-line reason, and two numbers that rank the work:
**probability** and **priority**. The logic is in `lib/opportunityScoring.ts`, it is
called by the opportunity engine, and the scorecard is stored on `CommercialOpportunity`.

| Dimension | Question | How it's scored |
|---|---|---|
| value | How valuable could this be? | Log-scaled from the offer's typical deal value (or its minimum): $1k → 25, $10k → 50, $100k → 75, $1M+ → 100. Unknown → 0, and the reason says to set a deal value on the offer. |
| intent | How likely are they to need something? | 60% event family (procurement 90, capacity 80, growth 65, organisational/digital 55, market 45, early 35), 40% signal intensity, plus up to +10 for accelerating or new signal velocity. |
| timing | How soon? | Age of the event's newest evidence, measured from the assessment time (< 3 days → 100 … > 90 days → 12), +10 when the offer's urgency indicators appear in the evidence. |
| offerFit | Does it match what the customer sells? | From the offer model (`offerModel.ts`). |
| evidenceConfidence | How certain is it that the event is real? | Average evidence quality, adjusted for independent corroboration. |
| contactability | Can we reach the right person? | Email 55, name 15, title 10, +20 when the title matches the offer's target buyer. |
| competition | How hard is it to win? | By event kind: open tender 80, contract opportunity 60, supplier change 50 … capacity shortage 30, early trigger 25. |

**Probability** (0–1) is confidence × offer fit, multiplied by three adjustments. Each
adjustment stays within a set range, so no single dimension dominates:

| Adjustment | Range |
|---|---|
| intent | 0.70–1.00 |
| contactability | 0.80–1.00 |
| competition | 1.00 (uncontested) down to 0.60 (fiercely contested) |

**Expected value** = mid deal value × probability. It is null when the value is unknown.

**Priority** (0–100) = expected commercial value × probability × urgency, normalised:
- urgency weighting: HIGH 1.0, MEDIUM 0.7, LOW 0.4 (from timing)
- value weighting: 0.75 when unknown, rising to 1.0 at $1M+
- scaled so that probability 0.6, high urgency and $1M+ gives priority 100

The opportunity's `intentScore`, `timingScore` and `contactability` columns now hold the
scorecard values. New nullable columns hold `competition`, `valueScore`,
`expectedValueCents` and the full `scorecard` with every reason. Rows assessed before this
change fill in on their next assessment.

`GET /api/commercial-opportunities` accepts `sort`:
- `priority` (default)
- `expectedValue` (unknown values last)
- `confidence`

## Not yet

- **The weights are fixed and explainable.** Calibrating them against real wins and
  losses (phases 11–12) waits for outcome data.
- **Competition is inferred from the type of event.** It doesn't yet know about actual
  incumbents or the number of bidders. Tender records in `Opportunity` could supply
  bidder counts later.

# Buying-Stage Intelligence (phase 7)

`lib/buyingStage.ts` answers "where is the buyer in the buying process?" instead of "is
this a good prospect?". Each stage has its own move:

| Stage | Move |
|---|---|
| NO_DETECTABLE_NEED | Don't contact; monitor |
| EMERGING_TRIGGER | Don't sell yet; share something useful |
| PROBLEM_LIKELY | Ask a qualifying question |
| ACTIVE_REQUIREMENT | Start outreach, tied to the event |
| EVALUATING_SOLUTIONS | Send proof: a case study or comparison |
| BUYING_DECISION | Push toward a quote or decision meeting |
| CUSTOMER | Deliver, then expand |

How the stage is set:
- **From events.** The stage comes from the strongest event, e.g. tender or procurement →
  evaluating; capacity shortage, new project or hiring surge → active requirement;
  expansion, funding or tech change → problem likely.
- **Low confidence.** An event below 55% confidence only counts as an emerging trigger.
- **Gate 1.** An uncorroborated event is held at "problem likely".
- **Engagement.** Only recorded engagement on the prospect moves it further: a meeting or
  proposal means a buying decision, and won means a customer. Evidence alone never claims
  a buyer is deciding.

**Stage gate.** "Contact now" is allowed only from active requirement up to buying
decision. Before that, the recommendation becomes the stage's move. Stage confidence,
reasons and the move are stored in `CommercialOpportunity.buyingStageDetail`.
