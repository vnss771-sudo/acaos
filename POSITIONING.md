# ACAOS positioning

The single source of truth for who ACAOS is for, what we say, what it costs, and
the words we use. Product copy, the README, onboarding and the demo all follow it.

## One line

**Find profitable work before your competitors, win it, run it, and learn which
work is actually worth chasing.**

## Who it's for

Trade contracting businesses — electrical first, then plumbing, HVAC, fire,
data and similar — with roughly 5 to 50 people on the tools, that win work from
builders, head contractors and developers.

The person we sell to is the owner or operations manager who:
- finds work by word of mouth, tender portals and phone calls, and misses some of it;
- prices jobs from experience and finds out the margin months later, if at all;
- runs crews on a spreadsheet or a separate rostering app.

## The problem

1. **Work is found late.** By the time a package is out to tender, the builder
   already has favourites. The early signal — a development application lodged,
   a head contract awarded, a builder hiring — is public but scattered.
2. **Margin is found never.** Job costing lives in a different tool (or nowhere),
   so nobody knows which *kind* of work pays.
3. **The two never meet.** The CRM knows what was won; the job tool knows what it
   cost. Nothing connects "where did this work come from" to "did it make money".

## The product: one loop

| Step | Screen | Plain-language promise |
|---|---|---|
| Find work | Work → Find work | "Every morning, the jobs that match your trade and area, with who to call." |
| Pursue, contact, quote | Find work card | "Record your price and hours while you're doing it — no admin later." |
| Win, start the job | Find work card / Today | "Client said yes? One click turns the quote into a job." |
| Crew and shifts | Crew | "Your crew logs hours against the job." |
| Close out | Work → Jobs & margins | "Enter the invoice and costs when it's done." |
| Margin | Jobs & margins, Today | "See what you made — and which kind of work pays best." |

**Today** is the home screen: what needs a decision, why (with the evidence),
won work waiting to start, and the numbers.

## Why us (and not…)

| Alternative | What it does | What it misses |
|---|---|---|
| Tender portals / alert emails | List tenders | Only the late, competitive stage; no DAs, no signals, no follow-through |
| Job management (simPRO, Fergus, ServiceM8) | Quote → job → invoice, job costing | Doesn't find work, and can't say which *source* of work is profitable |
| CRMs | Track deals | No delivery data, so "won" is the end of the story |

What only ACAOS does: **connects where work came from to what it earned**, and
shows it honestly — unknowns as unknown, patterns only with enough jobs behind them.

Job costing on its own is table stakes; we have it, but we never lead with it.

## Pricing (proposed, AUD, ex GST)

Plan keys in code stay `free` / `starter` / `growth` (they map to Stripe prices
server-side); customers see the names below. **The Stripe prices must be set to
these amounts before launch** — the app never hardcodes a price.

| Plan | Price | For | Includes |
|---|---|---|---|
| **Free** | $0 | Trying it | Find work for your trade; quotes, jobs, crew, shifts and margins; up to 2 team members |
| **Contractor** | $149 / month | Most trade businesses | Everything in Free; up to 5 team members; client signals and AI research; email outreach with approval; reply sorting |
| **Contractor Pro** | $349 / month | Multi-crew businesses | Everything in Contractor; up to 25 team members; multiple workspaces; dedicated onboarding; custom SLA |

Rationale: one won job typically covers a year of Contractor. Seat limits, AI
requests and discovery volume are the only gated items (see `PLAN_LIMITS` in
`packages/backend-core/src/lib/limits.ts`); the core loop is never paywalled,
because the margin data only exists if contractors use it.

Pilot offer for the first 5 customers: free for 3 months in exchange for closing
out every job in ACAOS — the data is worth more than the revenue.

## Terminology (use these words, everywhere)

| Say | Means | Don't say |
|---|---|---|
| **Work** / **job found** | A tender, contract award or development application Find work surfaced | opportunity (internal), lead |
| **Client** | A builder or business you could work for | prospect, potential client, account |
| **Signal** | Evidence a client may need you (hiring, expansion, contract win) | commercial event (internal) |
| **Quote** | The price and estimated hours you gave | proposal |
| **Won** | The client accepted the quote | closed, converted |
| **Job** | Won work being delivered | delivery job (internal) |
| **Site** | Where a job's shifts are logged | job site (fine in passing) |
| **Close out** | Finish a job: invoice + costs, figures frozen | complete, archive |
| **Labour margin** / **Gross margin** | Revenue minus labour / minus labour and other costs | profit |
| **Crew** | The people doing the work | workers, resources |
| **Today** | The landing screen | dashboard, command center |

Internal names (`Opportunity`, `CommercialOpportunity`, `OpsJobSite`, `Job`) stay
in code; they never appear in the UI.

## Messages

- Headline: *Find profitable work before your competitors.*
- Proof: *Every morning, jobs for your trade and area — with who to call.*
- The difference: *Know which work actually pays.*
- Trust: *Unknowns are shown as unknown, never $0. Nothing is emailed without your approval.*

Never claim: guaranteed wins, "AI that finds you jobs automatically" without the
human step, margin figures without their job counts.

## Where we were

ACAOS began as an email "Inbox Assistant" for agencies. That capability stays
(Outreach and Inbox), and the `starter` plan's customers keep it — it's now part
of the Contractor plan. The lead story is the contractor loop.

## Success metrics (first 90 days with pilot customers)

| Metric | Target |
|---|---|
| Work found that the customer didn't already know about | ≥ 3 per week |
| Quotes recorded from Find work | ≥ 2 per week |
| Jobs closed out in ACAOS (with invoice entered) | ≥ 80% of won jobs |
| Customers who can name their most profitable source of work | all of them, by day 90 |
