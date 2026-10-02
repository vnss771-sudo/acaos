# ACAOS Acquisition OS — Phase 3: Offer Intelligence + Next Best Action

## Purpose

Move from **commercial event detection** to **offer-specific opportunity judgement** without introducing an opaque model or changing the existing scoring formula.

## Added

- `offerIntelligence.ts`: deterministic mission-offer/evidence fit.
- `nextBestAction.ts`: conservative action policy.
- Focused tests covering strong fit, weak fit, enrichment, and contact-now gates.

## Safety rules

1. Missing offer data is neutral, not a positive signal.
2. No clear commercial event cannot produce `CONTACT_NOW`.
3. Missing buyer/contact data produces `ENRICH`, not outreach.
4. Low offer fit produces `MONITOR` or `RESEARCH_CONTACT`.
5. No LLM call participates in scoring or action selection.
6. Existing opportunity-score mathematics remain unchanged.
7. No database migration is introduced in this tranche.

## Next tranche

Persist commercial-event snapshots and offer-fit/action explanations alongside recommendations, then wire them into the operator console. Only after that should adaptive weighting be considered.
