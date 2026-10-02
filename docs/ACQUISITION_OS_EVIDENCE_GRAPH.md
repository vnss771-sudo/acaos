# Acquisition OS — Evidence Graph and Commercial Event Engine

This tranche implements plan phases **2 (Evidence Graph)** and **3 (Commercial Event Engine)**.
It builds on the signal intelligence, offer model and opportunity engine in
`ACQUISITION_OS_FOUNDATION.md`.

```
RAW SIGNALS ─▶ EVIDENCE ─▶ COMMERCIAL EVENTS ─▶ (offer) ─▶ OPPORTUNITY
                (quality)   (commercialEventEngine)        (opportunityEngine)
```

Raw signals never drive outreach directly. They become events, and every event can show
exactly which evidence it rests on. As before, the code is deterministic, makes no model
calls and sends nothing.

## Phase 3 — Commercial Event Engine (`lib/commercialEventEngine.ts`)

`detectCommercialEvents(signals)` returns **every** event the evidence supports,
strongest first. One company can be in a hiring surge and a geographic expansion at the
same time. Rules combine signal type, the wording of the evidence and signal velocity:

| Kind | Family | Detected from |
|---|---|---|
| TENDER_OPPORTUNITY | ACTIVE_PROCUREMENT | tender / RFQ / RFP / EOI wording |
| CONTRACT_OPPORTUNITY | ACTIVE_PROCUREMENT | other procurement activity |
| PROCUREMENT_CHANGE | ACTIVE_PROCUREMENT | supplier review, panel, switching supplier, re-tender |
| NEW_PROJECT | CAPACITY_EXPANSION | contract awarded, project commenced, development approved |
| CAPACITY_SHORTAGE | CAPACITY_EXPANSION | hiring that's urgent, immediate start, shortage, backlog |
| HIRING_SURGE | CAPACITY_EXPANSION | accelerating hiring velocity, 3+ recent hiring signals, or "17 field technicians" |
| CAPACITY_EXPANSION | CAPACITY_EXPANSION | expansion and hiring together |
| GEOGRAPHIC_EXPANSION | GROWTH_EVENT | new office / depot / site, expanding into a region |
| FUNDING_DEPLOYMENT | GROWTH_EVENT | funding |
| TECHNOLOGY_REPLACEMENT | DIGITAL_CHANGE | replacing, migrating, implementing a new system |
| REGULATORY_CHANGE | ORGANISATIONAL_CHANGE | regulation, compliance, new standards, licensing |
| OPERATIONAL_DISRUPTION | ORGANISATIONAL_CHANGE | outage, storm damage, recall, shutdown, insolvency |
| LEADERSHIP_RESET | ORGANISATIONAL_CHANGE | leadership change |
| EARLY_TRIGGER | EARLY_BUYING_TRIGGER | relevant recent activity matching no rule; confidence capped at 68 |

Each event carries:
- a **plain-language implication**, e.g. "Demand is outrunning capacity — likely need for
  extra people, equipment or outsourced delivery"
- why now
- confidence
- the number of independent sources
- whether it's corroborated
- an **evidence claim per supporting signal**: the claim, its source, URL, date and quality

**Gate 1 (intelligence truth)** is enforced per event:
- An event needs at least 2 independent sources and 1 trustworthy signal to be
  corroborated. Otherwise its confidence is capped at 60 and its why-now starts
  "Single-source so far".
- Unusable evidence, evidence older than 30 days, and evidence with reliability or
  relevance below 40 are excluded before any rule runs, so they can't create an event.

Each kind belongs to a **family**: the coarse event type the phase-2/3 code already used.
- Offers can be triggered by a specific kind (`TENDER_OPPORTUNITY`) or a whole family
  (`ACTIVE_PROCUREMENT`). `GET /api/offers` lists both.
- The next-best-action policy still works on families.
- The opportunity engine builds each opportunity on the **strongest event the offer is
  triggered by**, else the strongest event. The other events are listed in its reasons
  ("Also detected: …").
- An offer's disqualifiers are checked against all of the company's evidence from the
  last 180 days, not only the chosen event's. "In liquidation" disqualifies the company,
  whatever the event.

## Phase 2 — Evidence Graph (`CommercialEvent`, `EvidenceLink`, `/api/evidence-graph`)

```
source ─REPORTED─▶ signal ─SUPPORTS─▶ commercial event ─CREATES─▶ opportunity ◀─FOR_OFFER─ offer
                     ▲
company ─OBSERVED────┘
```

- **`CommercialEvent`**: one row per (prospect, kind).
  - It is **ACTIVE** while the evidence supports it and becomes **STALE** when it no
    longer does. A stale event is kept, links and all, as history.
  - It is maintained on every rescore, with or without offers.
- **`EvidenceLink`**: the edge from a signal to the event it supports, recording the claim
  that signal makes and its quality when linked. The links are a snapshot of the current
  evidence: replaced on each assessment, never accumulated.
- **`CommercialOpportunity.commercialEventId`** links each opportunity to its event.
  `eventType` now holds the specific kind. The new `eventFamily` and `implication`
  columns hold the family and what it means.
- **`GET /api/evidence-graph/:prospectId?workspaceId=`** (member-level, read-only)
  returns:
  - **nodes:** the company, its evidence sources, its signals (with live quality scores),
    its events, its opportunities and their offers
  - **edges** between them
  - a **narrative** per active event, e.g.:

  ```
  ABC Electrical: capacity expansion (confidence 86%).
  Expansion and workforce growth together indicate rising operational demand.
  Evidence:
  • Hiring 17 field technicians — jobs.example.com, 2026-09-29
  • New depot opened in Brisbane — news.example.org, 2026-09-29
  ```

  Stale events appear only with `includeStale=true`. A graph includes the 200 most recent
  signals and reports `truncated` beyond that.

## Deliberately not in this tranche

- No company-to-company relationships yet (e.g. the head contractor that won a tender
  and the client it's for). The tender records in `Opportunity` hold those parties, and
  a later tranche can link them into the graph.
- No UI. The operator console (phase 14) will draw on `/api/evidence-graph`.
- The event rules are fixed. Calibrating which events actually convert (phase 12) waits
  for outcome data.
