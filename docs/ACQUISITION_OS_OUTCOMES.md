# Acquisition OS — outcome graph (phase 10)

The outcome graph shows what happened after ACAOS spotted an opportunity:

DETECTED → RECOMMENDED → PROPOSED → APPROVED → SENT → REPLIED → MEETING → QUOTED → WON / LOST (→ revenue)

| Code | What |
|---|---|
| `lib/outcomeGraph.ts` | Pure chain builder and summary |
| `lib/outcomeGraphStore.ts` | Batched loaders, every query scoped by `workspaceId` |
| `GET /api/commercial-opportunities/:id/outcome?workspaceId=` | One opportunity's chain |
| `GET /api/commercial-opportunities/outcomes?workspaceId=&since=` | Funnel and attributed revenue |

## Sources

The graph is a read model. It adds no table or column, and it writes nothing.

| Stage | Record |
|---|---|
| DETECTED | `CommercialOpportunity.firstDetectedAt` |
| RECOMMENDED | The bridged `Recommendation` (phase 8) |
| PROPOSED, APPROVED | The `OutreachIntent`s proposed from the opportunity (phase 9) |
| SENT | The first `OutreachSent` stamped with one of those intents (status SENT or REPLIED) |
| REPLIED | The first non-auto reply on those sends (`repliedAt`, `replyIntent`) |
| MEETING, QUOTED, WON, LOST | The prospect's `ProspectOutcome`s (MEETING, PROPOSAL, WON, LOST) recorded on or after detection |
| WON / LOST | The opportunity's own operator status, when no recorded outcome covers it |
| Revenue | The WON outcome's `dealValue`. It's null when the win has no value recorded. |

Notes on how the stages are read:
- Sends from other campaigns, or from other opportunities' intents, don't count.
  Neither do failed or unsent rows.
- When the chain has both a WON and a LOST, the later one is the final outcome.
- A prospect's recorded outcomes apply to each of its opportunities detected before
  them. `ProspectOutcome` is recorded per prospect.

## Attribution

| Attribution | Meaning |
|---|---|
| SOURCED | The buyer's first response (reply, meeting, quote, won or lost) came after an ACAOS send for this opportunity |
| INFLUENCED | ACAOS had detected the opportunity, but the buyer moved with no ACAOS send before it |
| NONE | Nothing from the buyer yet |

## Summary

The summary covers the workspace's most recent 2000 opportunities. When there are
more, `truncated: true` is set.

- **`reached`:** how many chains reached each stage. A later buyer stage implies
  the earlier ones: a meeting implies a reply, and a win implies a quote. A loss
  implies nothing.
- **`conversion`:** of the chains that reached a step, the share that reached the
  next. The steps are detected → sent → replied → meeting → quoted → won.
- **`wonRevenueCents`:** won revenue, split into sourced and influenced.
- **`attribution`:** counts per attribution.

The graph feeds phase 11 (cause attribution), phase 12 (calibration) and the
"pipeline influenced by ACAOS" panel in phase 14.
