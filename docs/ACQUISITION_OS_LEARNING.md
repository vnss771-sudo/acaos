# Acquisition OS — closed-loop learning (phase 11)

For every opportunity that closed or stalled, this phase says why. Causes that keep
repeating become **advisory** proposals for a human to review. Nothing is changed
automatically, and approving a proposal changes nothing either.

| Code | What |
|---|---|
| `lib/outcomeCauses.ts` | Pure cause rules, the summary, findings and the proposal |
| `lib/outcomeGraphStore.ts` | Attaches a cause to every chain it loads |
| `lib/outcomeLearning.ts` | `learnFromOutcomes`: writes the advisory proposal |
| `lib/learningDecisions.ts` | Approve, reject and revert for advisory types |
| Worker `calibrate-scoring` job | Runs `learnFromOutcomes` after the scoring calibration (best-effort) |

## Causes

The rules are deterministic. They read the outcome chain (phase 10), the
opportunity's assessment, its event status, the reply intents on its sends, and the
grounding of drafts that went out. The first rule that matches is the cause.

| # | Cause | When |
|---|---|---|
| 1 | LOST_TO_COMPETITOR | Lost after a quote, or lost with competition ≥ 60 |
| 2 | WRONG_CONTACT | A send bounced, or the reply was REFERRAL |
| 3 | WRONG_TIMING | The reply was NOT_NOW |
| 4 | WRONG_SIGNAL | The event went STALE, or the opportunity never passed gate 1 |
| 5 | WRONG_CONTACT | Contactability < 40 |
| 6 | WRONG_TIMING | Sent before ACTIVE_REQUIREMENT, or the newest evidence was more than 30 days old at send |
| 7 | BAD_MESSAGE | After a send: an ungrounded draft went out, the reply was NOT_INTERESTED, or there was no response |
| 8 | UNKNOWN | None of the above |

Only some opportunities get a cause:
- **LOST:** always.
- **Still open:** only when it was sent and has had no response for 21 days or more
  (STALL_DAYS).
- **WON:** never.

Auto-replies don't count as replies. Each cause carries a confidence and its
reasons, and records whether it came from a closed or a stalled opportunity.

## Proposals: advisory, one per workspace

- **Findings.** Causes are grouped by event kind, by offer and by buying stage. A
  group becomes a finding when:
  - it has at least `LEARNING_LOOP_MIN_OUTCOMES` closed or stalled opportunities
    (default 10), and
  - its main cause, other than UNKNOWN, explains at least 40% of them.

  Each finding carries advice ("Verify the decision maker before outreach on
  these"), its counts and up to 5 example opportunity ids.
- **One review per workspace.** The schema allows a single PENDING proposal per
  `(workspace, type)`, so every finding goes into one `OPPORTUNITY_CAUSE`
  recommendation.
  - `proposedValue` holds only the findings: cause, dimension, value and advice.
  - `evidence` holds the counts.
  - An unchanged picture leaves the PENDING review alone. A changed one supersedes
    it. A concurrent run that loses the unique index keeps the other run's review.
- **Modes.** `LEARNING_ADAPTATION_MODE=off` does nothing. Every other mode,
  **including `live`**, only creates PENDING proposals.
- **Decisions.**
  - Approve records that a human reviewed the proposal. It is audited, nothing in
    the configuration changes, and it still expires after
    `LEARNING_RECOMMENDATION_TTL_DAYS`.
  - Revert returns 422, because there is nothing to undo.
  - Reject works as for every other type.

## Surfaces

- `GET /api/commercial-opportunities/:id/outcome` returns `{ chain, cause }`.
- `GET /api/commercial-opportunities/outcomes` adds `causes`, the count per cause.
- The settings Learning panel shows the review in plain language: the top advice,
  then each finding ("Wrong timing for event HIRING_SURGE"). Accepting it shows
  "Noted", and the panel has no Revert button for it.

## Next

Phase 12 (signal calibration) owns the config-writing proposals, such as event-kind
weights. The findings here are its qualitative input.
