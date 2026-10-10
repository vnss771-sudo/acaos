# Acquisition OS — commercial capture and delivery economics (phase 15)

Phases 1–13 make ACAOS good at finding and winning work. Phase 15 connects that to
what the work was actually worth: quote → job → hours → cost → revenue → margin.
The goal is to learn which work is worth chasing, not just which work can be won.

Phase 15 ships in three parts, and each one waits on real data from the one before:

| Part | What | Status |
|---|---|---|
| **15A Capture** | `Quote`, `Job`, accepted quote → job, closeout that freezes the economics | Done (API) |
| **15B Observe** | Capture screens in the web app; quoted vs delivered per job and per origin; quotes drive outcome attribution | Done |
| **15C Learn** | Margin by origin feeds an advisory `LearningRecommendation`, with minimum samples, never applied automatically | Next, once real closed jobs exist |

## Economic truth rules (don't break these)

1. **Shift records are the only source of actual hours.** `Job` never stores live hours.
2. **The Quote owns the estimate.** Quoted value and estimated hours live on the
   accepted `Quote`; `Job` points at it and copies nothing.
3. **Closeout freezes history.** `Job.closeout` is a snapshot. Changing a crew rate
   later never changes a closed job.
4. **A missing rate is unknown cost, never $0.** No recorded hours is also unknown,
   not free labour.
5. **Missing other costs are unknown, never $0.** Gross margin is then unknown.
6. **Labour margin ≠ gross margin.** `marginBasis` says which one is known: `GROSS`,
   `LABOUR` or `UNKNOWN`. Every unknown has a plain-language entry in `gaps`.
7. **Insufficient data ≠ inferred profitability.** No default margin is ever filled in.
8. **Reopening is an audited event,** not an edit. The prior snapshot goes into the
   audit log, and the next closeout increments `closeoutVersion`.
9. **Learning (15C) only reads closed jobs whose basis is known,** above a minimum sample.
10. **Learning stays advisory and reversible,** as in phases 11–12.

Also: money is integer cents. One accepted quote per opportunity (enforced by a
partial unique index). One job per job site for now, because shifts are recorded
against the site; if a site ever hosts repeat jobs, add `OpsShiftRecord.jobId` first.

## 15A — what shipped

| Code | What |
|---|---|
| `Quote` | One price for one opportunity: a Work-discovery `Opportunity` *or* a `CommercialOpportunity` (CHECK constraint). DRAFT → SUBMITTED → ACCEPTED / REJECTED; DRAFT/SUBMITTED → WITHDRAWN. A revision is a new quote. |
| `Job` | 1:1 with `OpsJobSite`; `quoteId`, status ACTIVE / COMPLETE, invoiced revenue, other costs, `closeout` snapshot, `closeoutVersion` |
| `lib/jobEconomics.ts` | Pure economics: hours, labour cost (with optional on-cost %), labour and gross margin, hours variance, revenue vs quote, `gaps` |
| `routes/delivery.ts` | `/api/delivery/*` below. Every endpoint, reads included, needs `ops:manage` (quotes, rates and margins are sensitive; crew are members). |
| Migration `20261003000000_commercial_capture` | Tables, CHECKs, partial unique indexes, and a backfill: one `Job` per site already created from a won opportunity |

| Endpoint | What |
|---|---|
| `GET /api/delivery/quotes?workspaceId=&opportunityId=&commercialOpportunityId=&status=` | Quotes, newest first |
| `POST /api/delivery/quotes` | Create (`submit: true` goes straight to SUBMITTED) |
| `PATCH /api/delivery/quotes/:id/status` | Lifecycle. ACCEPTED marks the opportunity WON in the same transaction and retires a commercial opportunity's outreach recommendation. |
| `POST /api/delivery/quotes/:id/job` | Accepted quote → job site + `Job`. If the opportunity already has a site, the quote attaches to that site's job instead. |
| `GET /api/delivery/jobs?workspaceId=&status=` / `GET /api/delivery/jobs/:id` | Jobs with `origin` and `economics` (live while ACTIVE, frozen once COMPLETE) |
| `POST /api/delivery/jobs/:id/closeout` | Freeze. Refused while any shift is open. Absent money fields keep what's recorded; `null` means unknown. |
| `POST /api/delivery/jobs/:id/reopen` | `{ reason }`; clears the snapshot, keeping it in the audit log |

The existing `POST /api/opportunities/:id/create-job` now also creates the `Job`, and
attaches the opportunity's accepted quote if there is one.

Audit types: `quote.created`, `quote.status`, `job.created`, `job.closeout`, `job.reopened`.

### Variations (UQ-35)

| Route | What |
|---|---|
| `POST /api/delivery/jobs/:id/variations` | `{ title, description?, revenueCents?, estimatedCostCents?, estimatedHours?, submit? }`. Only on an ACTIVE job (reopen a closed one first). `revenueCents` may be negative (scope reduction). |
| `PATCH /api/delivery/variations/:id/status` | `DRAFT → SUBMITTED → APPROVED \| REJECTED`; `DRAFT/SUBMITTED → CANCELLED`. Decided variations are final. |

- The accepted quote is never rewritten.
- Economics (version 2) add `approvedVariations`, `approvedVariationRevenueCents`, `approvedVariationCostCents`, `adjustedQuotedCents` and `revenueVsAdjustedQuotePct`. All of these are from APPROVED variations only.
- An unpriced approved variation makes the adjusted contract unknown, never zero.
- Estimated variation cost is never added to actual costs. Margins use the closeout's recorded costs.
- Audit types: `job.variation.created`, `job.variation.status`.

## 15B — what shipped

**Capture where the work already happens (web, admins only).**
- *Find work*: on an opportunity being pursued, **Record quote** (amount, estimated
  hours) goes straight to SUBMITTED. Then **Client accepted** (marks it won) or
  **Client declined**. The existing "Create job site" picks up the accepted quote.
- *Jobs & margins* (`ops-delivery`, `/ops/delivery`): each job's quoted vs delivered
  figures with its `gaps`; **Job done — close out** asks for the invoice amount,
  materials and subcontractors, and labour on-costs (blank = unknown); **Reopen**
  needs a reason.

**Observe.** `GET /api/delivery/report` groups closed jobs by origin (Work-discovery
kind, or the commercial signal kind) with median, range and *n* for hours vs
estimate, revenue vs quote, labour margin and gross margin (gross only over jobs
whose basis is GROSS). Below `DELIVERY_REPORT_MIN_JOBS` (3) a figure is withheld.
`buildDeliveryReport` in `lib/jobEconomics.ts` is pure.

**Outcome graph.** When a commercial opportunity has its own quotes, they set
QUOTED, WON and revenue (`ref.type: 'quote'`), and prospect-level PROPOSAL/WON/LOST
records are ignored for it (meetings still count). Opportunities without quotes
behave as before.

**Hardening.** A shift logged on a closed job's site after closeout is reported
as `shiftsAfterCloseout` on the job (and shown in the view): the frozen figures
don't include it until the job is reopened. `tests-db/delivery-loop.test.ts`
walks the whole loop over the real routes (find → quote → win → job → crew and
shifts via the Field Ops API → closeout → report) and checks the tenant boundary
on every delivery route.

**Not yet:** grouping by region (only Work-discovery opportunities carry one), and a
quote form on commercial opportunities in the web app (the API supports it; it
belongs with the operator console).

## 15C — later, and only with real closed jobs

- **Expected profit:** `deal value × P(win) × expected margin`. `expectedValueCents`
  already includes P(win), so don't multiply by probability twice.
- When the margin is unknown, fall back to value × P(win) labelled "margin unknown".
  Shrink margin estimates toward the workspace median, as phase 12 shrinks weights.
- Proposals are `LearningRecommendation` rows: PENDING, human-approved, reversible.
- Every margin shown anywhere carries its sample size.
- Selection bias: margins exist only for won jobs, and competitive channels (tenders)
  are partly low because winning needs a low price. Present them as how a channel
  performs under your pricing.
- Longer term: margin per crew-hour against roster capacity in the start window.
  For a trade business, crew hours usually bind before money does.
- Cross-customer margin pooling is out of scope (phase 13's floors apply at minimum).

**Success test to decide in advance:** after N closed jobs across M customers, does
margin differ meaningfully by origin? If it does, margin-aware ranking is the product.
If not, the value is in finding work earlier and in job costing itself.
