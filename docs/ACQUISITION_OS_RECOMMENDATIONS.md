# Acquisition OS — recommendation engine (phase 8)

Every commercial opportunity carries one explained move. The code is in
`packages/backend-core/src/lib/recommendationEngine.ts` and it runs inside
`assessOpportunity`, after the next-best-action and its gates.

## The moves

| Kind | When | Contacts the buyer? |
|---|---|---|
| `CONTACT_NOW` | The next-best-action is contact-now (it already passed the corroboration and stage gates) | yes |
| `SEND_CASE_STUDY` | Contact-now while the buyer is evaluating solutions, and the offer has a proof point | yes |
| `RESEARCH_INCUMBENT` | An evaluation with competition ≥ 60 and no proof point, or corroborated research-first with competition ≥ 60 | no |
| `ASK_QUALIFYING_QUESTION` | Research-first (weak fit, uncorroborated, or stage-gated) with at least one trustworthy signal | yes |
| `FIND_BUYER` | The next-best-action is enrich (no reachable decision maker) | no |
| `WAIT` (N days) | Already contacted (7 days), or only an emerging trigger (14 days); `revisitAt` is set | no |
| `MONITOR` | Monitor or hold, no trustworthy evidence, or a customer with no fresh trigger | no |
| `DONT_CONTACT` | No detectable need, or a lost deal with no new corroborated requirement | no |
| `ESCALATE` | Buying decision: a meeting or a proposal is recorded | no |
| `RE_ENGAGE` | A lost deal or an existing customer with a new corroborated trigger | yes |

The rules are checked in this order: customer, lost, buying decision, no need,
emerging trigger, then the next-best-action.

## Explanation (gate 2)

- `why` lists the reason for the move, then each cited claim with its age and
  source ("New depot opened in Brisbane — 9 days ago (news.example.org)"), then
  the stage reasons, then the scorecard reason that matters for the move.
- `citations` holds up to three evidence claims. Trustworthy claims come first,
  then the newest. Each keeps its `signalId`, so the claim traces back through the
  evidence graph.
- `headline` is one line: "Contact now: hiring 17 field technicians 3 days ago,
  new depot opened in Brisbane 9 days ago".
- **No explanation means no recommendation.** A move with no reason gives `null`,
  and so does a move that contacts the buyer without at least one cited claim.
- `nextSteps` starts with the move's own step. A case study adds the proof point.
  Outreach moves add up to three of the offer's `recommendedActions`.
- `WAIT`, `MONITOR` and `DONT_CONTACT` have their urgency set to LOW and their
  priority capped at 30.

## Persistence and the bridge

- `CommercialOpportunity.recommendationKind` and `.recommendation` (JSON) are
  refreshed on every assessment. Both are null when gate 2 withholds the
  recommendation.
- An outreach move on an OPEN or PURSUING opportunity is mirrored into a single
  `Recommendation` row, linked by `Recommendation.commercialOpportunityId`
  (unique). It's refreshed in place on each rescore, with a 7-day expiry. A row
  that someone has acted on (`actedAt`) is never rewritten.
- Any other case retires the un-acted row by setting `expiresAt = now`. That
  includes a non-outreach move, an expired opportunity, a removed offer, or an
  operator decision through `PATCH /:id/status` (WON, LOST, DISMISSED).
- **No `OutreachIntent` is created and nothing is sent.** Phase 9 turns a bridged
  recommendation into an intent and an evidence-grounded draft, and the existing
  approval, suppression and send-cap path stays in charge.
- A live bridged row also makes the rule-based `generate-recommendations` job
  skip that prospect, because of its 7-day dedupe. That keeps one recommendation
  per prospect on the radar.

## API

- The list endpoint `GET /api/commercial-opportunities` returns `recommendationKind`.
- The detail endpoint `GET /api/commercial-opportunities/:id` returns the full
  `recommendation`.

## Also in this phase

`chooseNextBestAction` now takes `now`, and the engine passes it in. Before this,
evidence age was the one value in an assessment that was read from the wall clock.
