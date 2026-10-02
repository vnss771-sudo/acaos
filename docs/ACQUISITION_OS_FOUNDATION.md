# Acquisition OS — Signal Intelligence, Offer Model, Opportunity Engine

This tranche moves ACAOS's core unit from the **lead** to the **commercial opportunity**.
It implements plan phases 1 (Signal Intelligence Layer), 4 (Offer Intelligence) and
5 (Opportunity Engine), building on the commercial-event classifier and next-best-action
policy from phases 2–3 (`ACQUISITION_OS_PHASE2.md`, `ACQUISITION_OS_PHASE3.md`).

```
Signals ─▶ quality + velocity ─▶ commercial event ─▶ offer fit ─▶ CommercialOpportunity
            (signalIntelligence)   (commercialEvent)   (offerModel)   (opportunityEngine)
```

Everything here is deterministic and explainable. No model call participates in scoring,
the existing opportunity-score maths (`signalEngine.ts`) is unchanged, and nothing here
sends anything.

## Phase 1 — Signal Intelligence Layer (`lib/signalIntelligence.ts`)

- **Canonical signal.** `toCanonicalSignal()` reads every stored signal into one shape:
  type, source, observedAt, publishedAt, entity, rawValue, normalizedValue,
  sourceReliability, relevance, evidence. Providers don't interpret their own signals.
  `Signal.publishedAt` (new, nullable) records when the source says the event happened.
  Freshness uses it when known, so old news that was only just detected counts as old.
- **Quality, scored independently per signal** (`assessSignalQuality`):

  | Dimension | Meaning |
  |---|---|
  | reliability | Source reliability blended with the evidence's own confidence. Capped at 60 with no recorded provenance. |
  | freshness | Fraction of strength left after the per-type decay `signalEngine.ts` already uses. |
  | specificity | A direct buying event, concrete figures and a cited source beat generic activity. |
  | relevance | ICP relevance. |
  | offerFit | Signal text vs the offer's terms. `null` when there's no offer to judge against. |
  | corroboration | Distinct independent sources (by URL host, else provider) within 30 days. |

  A signal is **UNUSABLE** when reliability is below 40 or freshness is below 10. It is
  **trustworthy** at overall ≥ 55 with reliability ≥ 50 and freshness ≥ 20.
- **Velocity.** `signalVelocity()` compares per-type counts in the last 30 days with the
  30 days before, giving trends like "Hiring signals up 340% over 30 days (22 vs 5)",
  NEW, DORMANT, ACCELERATING or DECELERATING. `metricVelocity()` does the same for a
  numeric series reported as `rawData: { metric, value }`, e.g. "headcount +23% over 30 days".

## Phase 4 — Offer Intelligence (`lib/offerModel.ts`, `Offer` table)

An explicit model of what the workspace sells:

- problem solved
- target customer and buyer titles
- triggering events
- qualifying and disqualifying keywords
- geography
- minimum and typical deal value
- urgency indicators
- proof points
- recommended actions

`evaluateOffer()` adjusts the fit score as follows:

- **Event match:** a matching triggering event adds 25. A clear event the offer isn't
  triggered by subtracts 10.
- **Keywords:** qualifying keywords are matched as whole phrases ("pool" doesn't match
  "liverpool").
- **Hard caps:** a disqualifier caps the fit at 10, and a location outside the offer's
  geography caps it at 20.

**Which offers a prospect is assessed against:**
1. Its mission's structured offers. If the mission has none, the mission's free-text
   offer instead, scored by the phase-3 lexical fit, so existing missions behave as before.
2. Plus every offer that isn't tied to a mission.
3. If there's none of these, the workspace business context stands in.
4. If there's nothing at all, no opportunities are created. An opportunity needs to know
   what the customer sells.

API (`/api/offers`):
- `GET` is available to any member.
- `POST`, `PUT /:id` and `DELETE /:id` need `icp:update`.
- Deleting an offer expires its OPEN opportunities.

## Phase 5 — Opportunity Engine (`lib/opportunityEngine.ts`, `CommercialOpportunity` table)

`assessOpportunity(prospect, signals, offer)` returns either an explainable opportunity or
`null`. It returns `null` when there's no clear commercial event, or when the offer is
disqualified. An opportunity carries:

- the event and why now
- confidence and evidence confidence
- the number of independent sources
- offer fit
- intent and timing scores
- contactability
- estimated value range
- probability, urgency and priority
- buying stage
- recommended buyer
- the recommended action, with its reason and blockers
- an **evidence claim per supporting signal** (signal id, source, URL, date, quality)
- signal velocity

**Priority = expected value × probability × urgency**, scaled to 0–100:
- probability = confidence × offer fit
- urgency: HIGH = 1, MEDIUM = 0.7, LOW = 0.4
- value weight: 0.75 when the value is unknown, rising logarithmically to 1.0 at $1M+

### Gates (enforced in the engine, not left to callers)

1. **Intelligence truth.** Unless at least 2 independent sources and at least one
   trustworthy signal support the event, confidence is capped at 60 and the reason says so.
   Unusable evidence is excluded before the event is inferred, so it can't manufacture one.
2. **Decision truth.** Every recommendation carries its reasons. "Contact now" resting on
   evidence that failed gate 1 is downgraded to "confirm the evidence before outreach".
3. **Commercial truth** is not claimed yet. WON/LOST on an opportunity is recorded and
   audited so a later tranche can calibrate on outcomes.

### Lifecycle

There is one row per (prospect, offer). The worker reassesses on every rescore
(`scoreProspects`), page by page and best-effort. Set `COMMERCIAL_OPPORTUNITIES_ENABLED=false`
to switch this off.

- New supporting evidence creates or refreshes the row.
- Evidence going stale, or the offer no longer applying, makes an OPEN row **EXPIRED**.
- Fresh evidence re-opens an EXPIRED row.
- Operator statuses (**PURSUING, WON, LOST, DISMISSED**) are never overwritten by the engine.

API (`/api/commercial-opportunities`):
- `GET /` returns opportunities by priority. DISMISSED and EXPIRED are hidden unless asked for.
- `GET /:id` returns the full evidence.
- `PATCH /:id/status` is the operator workflow and is audited.
- `POST /refresh` reassesses one prospect (member) or the whole workspace (`prospects:discover`).

The existing `Opportunity` table (tender and development-application records for Work
discovery and Field Ops) is untouched. `CommercialOpportunity` is the per-prospect object.

## Deliberately not in this tranche

- **Buying stage** is a provisional rules mapping from the event (phase 7 will refine it).
- No UI yet. The operator console (phase 14) will read `/api/commercial-opportunities`.
- No learned weights. Calibration (phases 11–12) waits for reliable outcome data.
- Recommendations and outreach intents are not yet generated from opportunities (phases 8–9).
- Signal ingest paths don't set `publishedAt` yet. `ingestSignal()` accepts it, and
  providers should pass it as they're updated.
