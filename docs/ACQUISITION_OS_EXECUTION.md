# Acquisition OS — intelligence → execution (phase 9)

This phase connects an opportunity to the existing outreach path:

opportunity → recommendation → `OutreachIntent` → evidence-grounded draft → approval → (existing) materialise and send

| Step | Code |
|---|---|
| Propose an intent | `lib/opportunityIntent.ts`, `POST /api/commercial-opportunities/:id/intent` |
| Grounding | `lib/draftGrounding.ts` |
| Draft and approve | `routes/prospects/intents.ts` (the existing routes, now grounding-aware) |

## Proposing an intent

`POST /api/commercial-opportunities/:id/intent` takes `{ workspaceId }` and needs
the admin role, like every other intent write.

**Preconditions.** Each failure returns 409 with the reason.
- The opportunity is OPEN or PURSUING.
- Its recommendation is an outreach move that cites evidence.
- Its bridged `Recommendation` row (from phase 8) is still live.

**What it creates.** One `OutreachIntent` with:
- `status` PROPOSED and `origin` `OPPORTUNITY`
- links to the opportunity (`commercialOpportunityId`) and the bridged recommendation
- the recommendation's headline as the message angle
- an evidence snapshot: the kind, the reasons and the citations
- a grounding record of the verified facts

**After it's created.**
- The recommendation is marked acted on, so a rescore no longer rewrites what the
  intent was proposed from.
- The request is idempotent. It returns 201 when it creates the intent and 200 with
  the existing intent after that. A concurrent duplicate resolves to the same intent.
- The proposal is audited as `outreachIntent.propose`.

## Grounding: no claim without evidence

- **Facts.** These are the recommendation's citations, numbered F1, F2 and so on.
  Each fact records claim → evidence (`signalId`) → source (with its URL) →
  confidence (the claim's evidence quality).
- **Drafting.** For an intent that has facts, the draft prompt's research summary is
  the fact list ("Verified facts — state nothing about the company beyond these").
  It replaces the free-text reasoning.
- **Checking.** Each generated draft (subject, body, follow-up) is checked
  deterministically, with no model call:
  - Every specific value it states (a number, an amount, a percentage) must
    appear in a fact or in the seller's own context: the offer, proof points,
    recommended actions, business context, or the company name and location.
    Anything else becomes "States "9m" without evidence".
  - It must use at least one fact, matched on a shared value or two shared
    significant words. Otherwise it gets "Uses none of the verified facts".
- **The stored record.** It lists the facts the draft used (claim → evidence →
  source → confidence, plus what matched), the problems, and `grounded`.
- **Approval.** `POST …/intents/:intentId/approve` refuses a draft whose grounding
  has `grounded: false` (409, with the problems). Regenerating the draft re-checks it.
- **Intents from other paths are unchanged.** Rule-based and onboarding intents
  have no grounding record.

## What stays in charge

Approval, materialising, policy checks, approval mode, suppression and send caps
are all the existing path. Phase 9 adds no send and no automatic step. Each
proposal, draft and approval is an operator action.

## Limits

- The grounding check catches invented specifics and drafts that ignore the
  evidence. It can't catch a qualitative claim with no number in it ("you're
  expanding into Sydney"). The drafting prompt still forbids stating facts it
  wasn't given.
- Facts are only as fresh as the recommendation they were proposed from. To pick up
  newer evidence, propose a new intent from a re-opened opportunity.
