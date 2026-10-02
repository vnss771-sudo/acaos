# Acquisition OS — Phase 2: Commercial Event Intelligence

## Purpose

ACAOS must not jump directly from a raw signal to outreach. Phase 2 adds a conservative,
deterministic interpretation layer:

`Signals -> Commercial Event hypothesis -> Recommendation`

## Implemented

- `commercialEvent.ts`: classifies recent, sufficiently reliable/relevant signal combinations.
- `offerFit.ts`: conservative lexical offer-to-evidence fit floor; no AI claims.
- `signalEngine.ts`: corroborated recommendations now explain the inferred commercial event.
- focused tests cover direct procurement, corroborated expansion/hiring, stale/weak evidence,
offer fit, and recommendation explanation.

## Safety rules

1. No event is inferred from stale evidence.
2. Low-quality evidence cannot manufacture a commercial event.
3. A single weak signal remains an early trigger, not a confident buying event.
4. The classifier is deterministic and explainable.
5. Existing opportunity-score mathematics is unchanged in this tranche.
6. No autonomous sending is introduced.

## Next tranche

Persist commercial-event snapshots and evidence links only after Prisma generation and DB tests
are available. Then add mission-specific offer fit and next-best-action scoring. Do not introduce
learned weights until downstream outcomes are being recorded reliably.
