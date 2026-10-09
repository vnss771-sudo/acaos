import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { Prisma } from '@prisma/client'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { retireBridge } from '@acaos/backend-core/lib/commercialOpportunityStore.js'
import { computeJobEconomics, canTransitionQuote, buildDeliveryReport, QUOTE_STATUSES, type JobEconomics } from '@acaos/backend-core/lib/jobEconomics.js'
import { FIND_WORK_KIND_LABEL, loadPilotScorecard, SCORECARD_DEFAULT_WEEKS, SCORECARD_MAX_WEEKS } from '@acaos/backend-core/lib/pilotScorecard.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../lib/validate.js'
import type {
  Assert, Extends, CreateQuoteRequest, UpdateQuoteStatusRequest, CreateJobFromQuoteRequest, CloseoutJobRequest, ReopenJobRequest,
} from '@acaos/shared'

// Commercial capture (phase 15A, docs/ACQUISITION_OS_DELIVERY.md): quotes on
// opportunities, the delivery Job a won quote becomes, and the job's economics.
// Every endpoint — reads included — is 'ops:manage': quotes, crew rates and
// margins are commercially sensitive, and crew members are workspace members.
export const deliveryRouter = Router()
deliveryRouter.use(requireAuth)
deliveryRouter.use(requireVerifiedForMutation)

const MAX_CENTS = 2_000_000_000 // fits Postgres INTEGER with headroom ($20M)
const centsField = z.number().int().min(0).max(MAX_CENTS)
const idParamsSchema = z.object({ id: idField })

// ── Quotes ──────────────────────────────────────────────────────────────────

const quoteListSchema = z.object({
  workspaceId: workspaceIdField,
  opportunityId: idField.optional(),
  commercialOpportunityId: idField.optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
})

// GET /api/delivery/quotes — newest first, optionally for one opportunity.
deliveryRouter.get(
  '/quotes',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(quoteListSchema, req)
    await assertWorkspacePermission(user.id, q.workspaceId, 'ops:manage')
    const quotes = await prisma.quote.findMany({
      where: {
        workspaceId: q.workspaceId,
        ...(q.opportunityId ? { opportunityId: q.opportunityId } : {}),
        ...(q.commercialOpportunityId ? { commercialOpportunityId: q.commercialOpportunityId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { job: { select: { id: true, status: true } } },
    })
    res.json({ quotes })
  })
)

const createQuoteSchema = z.object({
  workspaceId: workspaceIdField,
  opportunityId: idField.optional(),
  commercialOpportunityId: idField.optional(),
  amountCents: centsField,
  estimatedHours: z.number().min(0).max(1_000_000).optional(),
  notes: z.string().trim().max(2000).optional(),
  submit: z.boolean().optional(),
}).refine(b => (b.opportunityId == null) !== (b.commercialOpportunityId == null), {
  message: 'Give exactly one of opportunityId or commercialOpportunityId', path: ['opportunityId'],
})
type _CreateQuoteConforms = Assert<Extends<z.infer<typeof createQuoteSchema>, CreateQuoteRequest>>

// POST /api/delivery/quotes — record a price put to the buyer. A revision is a
// new quote (withdraw the old one), so every figure ever quoted stays on record.
deliveryRouter.post(
  '/quotes',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const b = parseBody(createQuoteSchema, req)
    await assertWorkspacePermission(user.id, b.workspaceId, 'ops:manage')
    const target = b.opportunityId
      ? await prisma.opportunity.findFirst({ where: { id: b.opportunityId, workspaceId: b.workspaceId }, select: { id: true } })
      : await prisma.commercialOpportunity.findFirst({ where: { id: b.commercialOpportunityId!, workspaceId: b.workspaceId }, select: { id: true } })
    if (!target) throw new ApiError(404, 'Opportunity not found')

    const now = new Date()
    const quote = await prisma.quote.create({
      data: {
        workspaceId: b.workspaceId,
        opportunityId: b.opportunityId ?? null,
        commercialOpportunityId: b.commercialOpportunityId ?? null,
        amountCents: b.amountCents,
        estimatedHours: b.estimatedHours ?? null,
        notes: b.notes || null,
        status: b.submit ? 'SUBMITTED' : 'DRAFT',
        submittedAt: b.submit ? now : null,
        createdByUserId: user.id,
      },
    })
    await recordAudit({
      workspaceId: b.workspaceId, actorUserId: user.id, type: 'quote.created', entityType: 'quote', entityId: quote.id,
      metadata: { amountCents: b.amountCents, estimatedHours: b.estimatedHours ?? null, status: quote.status, opportunityId: b.opportunityId ?? null, commercialOpportunityId: b.commercialOpportunityId ?? null },
    })
    res.status(201).json({ quote })
  })
)

const quoteStatusSchema = z.object({
  workspaceId: workspaceIdField,
  status: z.enum(['SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']),
})
type _QuoteStatusConforms = Assert<Extends<z.infer<typeof quoteStatusSchema>, UpdateQuoteStatusRequest>>

type QuoteRow = { id: string; status: string; opportunityId: string | null; commercialOpportunityId: string | null }

// PATCH /api/delivery/quotes/:id/status — move a quote through its lifecycle.
// ACCEPTED is a win: the quoted opportunity is marked WON in the same
// transaction, and a second accepted quote for it is refused by the database.
deliveryRouter.patch(
  '/quotes/:id/status',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId, status } = parseBody(quoteStatusSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
    const existing = await prisma.quote.findFirst({ where: { id, workspaceId } }) as QuoteRow | null
    if (!existing) throw new ApiError(404, 'Quote not found')
    if (!canTransitionQuote(existing.status, status)) throw new ApiError(409, `A ${existing.status} quote can't become ${status}`)

    const now = new Date()
    let quote
    try {
      quote = await prisma.$transaction(async (tx) => {
        // Guarded on the status we read, so two concurrent decisions can't both apply.
        const moved = await tx.quote.updateMany({
          where: { id, workspaceId, status: existing.status },
          data: { status, ...(status === 'SUBMITTED' ? { submittedAt: now } : { decidedAt: now }) },
        })
        if (moved.count === 0) throw new ApiError(409, 'The quote changed while you were deciding — reload and try again')
        if (status === 'ACCEPTED') {
          const won = { status: 'WON', statusChangedAt: now, statusChangedByUserId: user.id }
          if (existing.opportunityId) await tx.opportunity.updateMany({ where: { id: existing.opportunityId, workspaceId, status: { not: 'WON' } }, data: won })
          if (existing.commercialOpportunityId) await tx.commercialOpportunity.updateMany({ where: { id: existing.commercialOpportunityId, workspaceId, status: { not: 'WON' } }, data: won })
        }
        return tx.quote.findFirst({ where: { id, workspaceId } })
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ApiError(409, 'Another quote for this opportunity is already accepted')
      throw err
    }
    // A won commercial opportunity's outreach recommendation no longer stands.
    if (status === 'ACCEPTED' && existing.commercialOpportunityId) await retireBridge(workspaceId, existing.commercialOpportunityId, now)
    await recordAudit({
      workspaceId, actorUserId: user.id, type: 'quote.status', entityType: 'quote', entityId: id,
      metadata: { from: existing.status, to: status },
    })
    res.json({ quote })
  })
)

const createJobSchema = z.object({
  workspaceId: workspaceIdField,
  jobCode: z.string().trim().min(1).max(64).optional(),
})
type _CreateJobConforms = Assert<Extends<z.infer<typeof createJobSchema>, CreateJobFromQuoteRequest>>

// POST /api/delivery/quotes/:id/job — start delivering an accepted quote: a
// Field Ops job site plus its Job. If the quoted Work-discovery opportunity
// already has a site (created before quotes existed), the quote attaches to
// that site's Job instead of creating a second site.
deliveryRouter.post(
  '/quotes/:id/job',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId, jobCode } = parseBody(createJobSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
    const quote = await prisma.quote.findFirst({
      where: { id, workspaceId },
      include: {
        job: { select: { id: true } },
        opportunity: { select: { id: true, title: true, address: true, locality: true, region: true, lat: true, lng: true, opsJobSiteId: true, counterpartyName: true, sourceUrl: true } },
        commercialOpportunity: { select: { id: true, eventTitle: true, prospect: { select: { companyName: true } } } },
      },
    }) as null | {
      id: string; status: string; job: { id: string } | null
      opportunity: { id: string; title: string; address: string | null; locality: string | null; region: string | null; lat: number | null; lng: number | null; opsJobSiteId: string | null; counterpartyName: string | null; sourceUrl: string | null } | null
      commercialOpportunity: { id: string; eventTitle: string; prospect: { companyName: string } } | null
    }
    if (!quote) throw new ApiError(404, 'Quote not found')
    if (quote.status !== 'ACCEPTED') throw new ApiError(409, 'Only an accepted quote becomes a job')
    if (quote.job) throw new ApiError(409, 'A job already exists for this quote')

    const opp = quote.opportunity
    const co = quote.commercialOpportunity
    let job
    try {
      job = await prisma.$transaction(async (tx) => {
        if (opp?.opsJobSiteId) {
          const siteJob = await tx.job.findFirst({ where: { workspaceId, opsJobSiteId: opp.opsJobSiteId } }) as { id: string; quoteId: string | null } | null
          if (siteJob?.quoteId) throw new ApiError(409, 'This opportunity\'s job already has an accepted quote')
          if (siteJob) {
            const linked = await tx.job.updateMany({ where: { id: siteJob.id, workspaceId, quoteId: null }, data: { quoteId: quote.id } })
            if (linked.count === 0) throw new ApiError(409, 'This opportunity\'s job already has an accepted quote')
            return tx.job.findFirst({ where: { id: siteJob.id, workspaceId } })
          }
          return tx.job.create({ data: { workspaceId, opsJobSiteId: opp.opsJobSiteId, quoteId: quote.id } })
        }
        const title = opp ? opp.title : `${co?.prospect.companyName ?? 'Client'} — ${co?.eventTitle ?? 'job'}`
        const notes = [
          opp?.counterpartyName ? `Client / head contractor: ${opp.counterpartyName}` : null,
          co ? `Client: ${co.prospect.companyName}` : null,
          opp?.sourceUrl ? `Source: ${opp.sourceUrl}` : null,
        ].filter(Boolean).join('\n')
        const site = await tx.opsJobSite.create({
          data: {
            workspaceId,
            jobCode: jobCode ?? `Q-${quote.id.slice(-6).toUpperCase()}`,
            siteName: title.slice(0, 200),
            location: opp ? ((opp.address ?? [opp.locality, opp.region].filter(Boolean).join(', ')).slice(0, 200) || null) : null,
            lat: opp?.lat ?? null, lng: opp?.lng ?? null,
            status: 'ACTIVE',
            notes: notes.slice(0, 2000) || null,
          },
        })
        if (opp) {
          const linked = await tx.opportunity.updateMany({ where: { id: opp.id, workspaceId, opsJobSiteId: null }, data: { opsJobSiteId: site.id } })
          if (linked.count === 0) throw new ApiError(409, 'A job site was already created for this opportunity')
        }
        return tx.job.create({ data: { workspaceId, opsJobSiteId: site.id, quoteId: quote.id } })
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ApiError(409, 'A job site with this job code already exists, or this quote already has a job')
      throw err
    }
    const created = job as { id: string; opsJobSiteId: string }
    await recordAudit({
      workspaceId, actorUserId: user.id, type: 'job.created', entityType: 'job', entityId: created.id,
      metadata: { quoteId: quote.id, opsJobSiteId: created.opsJobSiteId },
    })
    res.status(201).json({ job })
  })
)

// ── Jobs ────────────────────────────────────────────────────────────────────

type JobRow = {
  id: string; workspaceId: string; opsJobSiteId: string; quoteId: string | null; status: string
  invoicedRevenueCents: number | null; otherCostCents: number | null; closeout: unknown; closeoutVersion: number
  startedAt: Date; completedAt: Date | null
  opsJobSite: { id: string; jobCode: string; siteName: string; status: string; opportunities: Array<{ id: string; kind: string; source: string; title: string }> }
  quote: null | {
    id: string; amountCents: number; estimatedHours: number | null
    opportunity: { id: string; kind: string; source: string; title: string } | null
    commercialOpportunity: { id: string; eventType: string; eventFamily: string | null; eventTitle: string } | null
  }
}

const opportunityOrigin = { select: { id: true, kind: true, source: true, title: true } }
const jobInclude = {
  opsJobSite: { select: { id: true, jobCode: true, siteName: true, status: true, opportunities: opportunityOrigin } },
  quote: {
    select: {
      id: true, amountCents: true, estimatedHours: true,
      opportunity: opportunityOrigin,
      commercialOpportunity: { select: { id: true, eventType: true, eventFamily: true, eventTitle: true } },
    },
  },
}

// Where the work came from — the dimension phase 15B groups economics by.
function originOf(job: JobRow) {
  const co = job.quote?.commercialOpportunity
  if (co) return { type: 'COMMERCIAL_OPPORTUNITY' as const, id: co.id, kind: co.eventType, family: co.eventFamily, title: co.eventTitle }
  const opp = job.quote?.opportunity ?? job.opsJobSite.opportunities[0]
  if (opp) return { type: 'OPPORTUNITY' as const, id: opp.id, kind: opp.kind, source: opp.source, title: opp.title }
  return null
}

// Live economics for ACTIVE jobs, derived from shifts (never stored), with one
// query for shifts and one for crew rates however many jobs are listed.
async function liveEconomics(workspaceId: string, jobs: JobRow[]): Promise<Map<string, JobEconomics>> {
  const out = new Map<string, JobEconomics>()
  const live = jobs.filter(j => j.closeout == null)
  if (live.length === 0) return out
  const shifts = await prisma.opsShiftRecord.findMany({
    where: { workspaceId, jobSiteId: { in: live.map(j => j.opsJobSiteId) } },
    select: { jobSiteId: true, crewMemberId: true, totalHours: true, endTime: true },
  }) as Array<{ jobSiteId: string; crewMemberId: string; totalHours: number; endTime: Date | null }>
  const crewIds = [...new Set(shifts.map(s => s.crewMemberId))]
  const crew = crewIds.length
    ? await prisma.opsCrewMember.findMany({ where: { workspaceId, id: { in: crewIds } }, select: { id: true, baseRate: true } }) as Array<{ id: string; baseRate: number | null }>
    : []
  const rates = new Map(crew.map(c => [c.id, c.baseRate]))
  for (const j of live) {
    out.set(j.id, computeJobEconomics({
      shifts: shifts.filter(s => s.jobSiteId === j.opsJobSiteId),
      rates,
      quote: j.quote ? { amountCents: j.quote.amountCents, estimatedHours: j.quote.estimatedHours } : null,
      revenueCents: j.invoicedRevenueCents,
      otherCostCents: j.otherCostCents,
    }))
  }
  return out
}

// Shifts logged on a closed job's site after its closeout: the frozen figures
// don't include them, so the job says so (reopen to include them).
async function lateShiftCounts(workspaceId: string, jobs: JobRow[]): Promise<Map<string, number>> {
  const closed = jobs.filter(j => j.closeout != null && j.completedAt)
  const out = new Map<string, number>()
  if (closed.length === 0) return out
  const rows = await prisma.opsShiftRecord.findMany({
    where: { workspaceId, jobSiteId: { in: closed.map(j => j.opsJobSiteId) } },
    select: { jobSiteId: true, createdAt: true },
  }) as Array<{ jobSiteId: string; createdAt: Date }>
  for (const j of closed) {
    const n = rows.filter(r => r.jobSiteId === j.opsJobSiteId && r.createdAt > j.completedAt!).length
    if (n > 0) out.set(j.id, n)
  }
  return out
}

function present(job: JobRow, live: Map<string, JobEconomics>, late: Map<string, number> = new Map()) {
  const { opsJobSite, quote, closeout, ...rest } = job
  return {
    ...rest,
    site: { id: opsJobSite.id, jobCode: opsJobSite.jobCode, siteName: opsJobSite.siteName, status: opsJobSite.status },
    quote: quote ? { id: quote.id, amountCents: quote.amountCents, estimatedHours: quote.estimatedHours } : null,
    origin: originOf(job),
    // A completed job reports its frozen snapshot; an active one, the live view.
    economics: (closeout as JobEconomics | null) ?? live.get(job.id) ?? null,
    economicsFrozen: closeout != null,
    shiftsAfterCloseout: late.get(job.id) ?? 0,
  }
}

const jobListSchema = z.object({
  workspaceId: workspaceIdField,
  status: z.enum(['ACTIVE', 'COMPLETE', 'CANCELLED']).optional(),
})

// GET /api/delivery/jobs — delivery jobs with their origin and economics.
deliveryRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(jobListSchema, req)
    await assertWorkspacePermission(user.id, q.workspaceId, 'ops:manage')
    const jobs = await prisma.job.findMany({
      where: { workspaceId: q.workspaceId, ...(q.status ? { status: q.status } : {}) },
      orderBy: { startedAt: 'desc' },
      take: 200,
      include: jobInclude,
    }) as JobRow[]
    const [live, late] = await Promise.all([liveEconomics(q.workspaceId, jobs), lateShiftCounts(q.workspaceId, jobs)])
    res.json({ jobs: jobs.map(j => present(j, live, late)) })
  })
)

const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })

// The report also needs where each job was. Kept out of the shared jobInclude so
// list/detail payloads are unchanged.
const locatedOpportunity = { select: { ...opportunityOrigin.select, region: true, locality: true } }
const reportJobInclude = {
  opsJobSite: { select: { ...jobInclude.opsJobSite.select, location: true, opportunities: locatedOpportunity } },
  quote: {
    select: {
      ...jobInclude.quote.select,
      opportunity: locatedOpportunity,
      commercialOpportunity: { select: { ...jobInclude.quote.select.commercialOpportunity.select, prospect: { select: { location: true } } } },
    },
  },
}
type Located = { region?: string | null; locality?: string | null }
type ReportJobRow = JobRow & {
  opsJobSite: { location: string | null; opportunities: Located[] }
  quote: null | { opportunity: Located | null; commercialOpportunity: { prospect: { location: string | null } | null } | null }
}

/**
 * Where the work was, most trustworthy first: the source opportunity's state
 * code, the commercial opportunity's prospect location, the opportunity's
 * locality, then the site's location. Free-text values are grouped as written
 * (case/space-insensitive); a missing location stays "Unknown region".
 */
function regionOf(job: ReportJobRow): { key: string; label: string } {
  const opp = job.quote?.opportunity ?? job.opsJobSite.opportunities[0]
  const candidates = [opp?.region, job.quote?.commercialOpportunity?.prospect?.location, opp?.locality, job.opsJobSite.location]
  const label = candidates.map(v => v?.trim().replace(/\s+/g, ' ')).find(v => !!v)
  return label ? { key: `REGION:${label.toLowerCase()}`, label } : { key: 'REGION:UNKNOWN', label: 'Unknown region' }
}

// GET /api/delivery/report — closed jobs grouped by where the work came from
// (report) and by where it was (regionalReport): medians with their n, withheld
// below the floor. Registered before /jobs/:id.
deliveryRouter.get(
  '/report',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
    const jobs = await prisma.job.findMany({
      where: { workspaceId, status: 'COMPLETE' },
      orderBy: { completedAt: 'desc' },
      take: 1000,
      include: reportJobInclude,
    }) as ReportJobRow[]
    const closed = jobs.filter(j => j.closeout != null)
    const report = buildDeliveryReport(closed.map(j => {
      const o = originOf(j)
      const kind = o?.kind ?? 'UNKNOWN'
      const label = o == null ? 'Unknown origin'
        : o.type === 'OPPORTUNITY' ? (FIND_WORK_KIND_LABEL[kind] ?? kind)
        : `Signal: ${kind.toLowerCase().replace(/_/g, ' ')}`
      return { originKey: `${o?.type ?? 'NONE'}:${kind}`, originLabel: label, economics: j.closeout as JobEconomics }
    }))
    const regionalReport = buildDeliveryReport(closed.map(j => {
      const r = regionOf(j)
      return { originKey: r.key, originLabel: r.label, economics: j.closeout as JobEconomics }
    }))
    res.json({ report, regionalReport })
  })
)

const scorecardQuerySchema = z.object({
  workspaceId: workspaceIdField,
  weeks: z.coerce.number().int().min(1).max(SCORECARD_MAX_WEEKS).default(SCORECARD_DEFAULT_WEEKS),
})

// GET /api/delivery/scorecard — the pilot scorecard: what Find work found, what
// was quoted and won each week against the pilot targets, how much won work
// was closed out, and which source made the most money.
deliveryRouter.get(
  '/scorecard',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, weeks } = parseQuery(scorecardQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
    res.json({ scorecard: await loadPilotScorecard(workspaceId, { weeks }) })
  })
)

async function loadJob(id: string, workspaceId: string): Promise<JobRow> {
  const job = await prisma.job.findFirst({ where: { id, workspaceId }, include: jobInclude }) as JobRow | null
  if (!job) throw new ApiError(404, 'Job not found')
  return job
}

// GET /api/delivery/jobs/:id
deliveryRouter.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
    const job = await loadJob(id, workspaceId)
    const [live, late] = await Promise.all([liveEconomics(workspaceId, [job]), lateShiftCounts(workspaceId, [job])])
    res.json({ job: present(job, live, late) })
  })
)

const closeoutSchema = z.object({
  workspaceId: workspaceIdField,
  invoicedRevenueCents: centsField.nullable().optional(),
  otherCostCents: centsField.nullable().optional(),
  onCostPct: z.number().min(0).max(100).optional(),
})
type _CloseoutConforms = Assert<Extends<z.infer<typeof closeoutSchema>, CloseoutJobRequest>>

// POST /api/delivery/jobs/:id/closeout — the job is done: record what it was
// invoiced and what else it cost, and freeze its economics. Refused while any
// shift is still open, because the hours aren't final yet.
deliveryRouter.post(
  '/jobs/:id/closeout',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const b = parseBody(closeoutSchema, req)
    await assertWorkspacePermission(user.id, b.workspaceId, 'ops:manage')
    const job = await loadJob(id, b.workspaceId)
    if (job.status !== 'ACTIVE') throw new ApiError(409, `A ${job.status} job can't be closed out`)

    const shifts = await prisma.opsShiftRecord.findMany({
      where: { workspaceId: b.workspaceId, jobSiteId: job.opsJobSiteId },
      select: { crewMemberId: true, totalHours: true, endTime: true },
    }) as Array<{ crewMemberId: string; totalHours: number; endTime: Date | null }>
    const open = shifts.filter(s => s.endTime == null).length
    if (open > 0) throw new ApiError(409, `${open} shift(s) on this job are still open — clock them out first`)
    const crewIds = [...new Set(shifts.map(s => s.crewMemberId))]
    const crew = crewIds.length
      ? await prisma.opsCrewMember.findMany({ where: { workspaceId: b.workspaceId, id: { in: crewIds } }, select: { id: true, baseRate: true } }) as Array<{ id: string; baseRate: number | null }>
      : []

    // Absent = keep what is recorded; null = explicitly unknown.
    const revenueCents = b.invoicedRevenueCents !== undefined ? b.invoicedRevenueCents : job.invoicedRevenueCents
    const otherCostCents = b.otherCostCents !== undefined ? b.otherCostCents : job.otherCostCents
    const now = new Date()
    const snapshot = {
      ...computeJobEconomics({
        shifts,
        rates: new Map(crew.map(c => [c.id, c.baseRate])),
        quote: job.quote ? { amountCents: job.quote.amountCents, estimatedHours: job.quote.estimatedHours } : null,
        revenueCents,
        otherCostCents,
        onCostPct: b.onCostPct,
      }),
      frozenAt: now.toISOString(),
    }
    const closed = await prisma.job.updateMany({
      where: { id, workspaceId: b.workspaceId, status: 'ACTIVE' },
      data: {
        status: 'COMPLETE', closeout: snapshot, closeoutVersion: { increment: 1 },
        invoicedRevenueCents: revenueCents, otherCostCents, completedAt: now, closedByUserId: user.id,
      },
    })
    if (closed.count === 0) throw new ApiError(409, 'The job changed while closing out — reload and try again')
    await recordAudit({
      workspaceId: b.workspaceId, actorUserId: user.id, type: 'job.closeout', entityType: 'job', entityId: id,
      metadata: { closeoutVersion: job.closeoutVersion + 1, marginBasis: snapshot.marginBasis, grossMarginCents: snapshot.grossMarginCents, labourMarginCents: snapshot.labourMarginCents },
    })
    const updated = await loadJob(id, b.workspaceId)
    res.json({ job: present(updated, new Map()) })
  })
)

const reopenSchema = z.object({
  workspaceId: workspaceIdField,
  reason: z.string().trim().min(3).max(500),
})
type _ReopenConforms = Assert<Extends<z.infer<typeof reopenSchema>, ReopenJobRequest>>

// POST /api/delivery/jobs/:id/reopen — undo a closeout (more hours, a late
// invoice). The frozen snapshot is cleared here and kept in the audit log; the
// next closeout writes a new version. Never a silent edit of history.
deliveryRouter.post(
  '/jobs/:id/reopen',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId, reason } = parseBody(reopenSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
    const job = await loadJob(id, workspaceId)
    if (job.status !== 'COMPLETE') throw new ApiError(409, 'Only a completed job can be reopened')
    const reopened = await prisma.job.updateMany({
      where: { id, workspaceId, status: 'COMPLETE' },
      data: { status: 'ACTIVE', closeout: Prisma.JsonNull, completedAt: null },
    })
    if (reopened.count === 0) throw new ApiError(409, 'The job changed while reopening — reload and try again')
    await recordAudit({
      workspaceId, actorUserId: user.id, type: 'job.reopened', entityType: 'job', entityId: id,
      metadata: { reason, closeoutVersion: job.closeoutVersion, previousCloseout: job.closeout as never },
    })
    const updated = await loadJob(id, workspaceId)
    res.json({ job: present(updated, await liveEconomics(workspaceId, [updated])) })
  })
)
