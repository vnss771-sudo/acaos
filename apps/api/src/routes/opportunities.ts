import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../lib/validate.js'
import { TRADES, TRADE_IDS } from '@acaos/backend-core/lib/opportunityTaxonomy.js'
import { AU_REGIONS, OPPORTUNITY_STATUSES } from '@acaos/backend-core/lib/opportunityTypes.js'
import { OPPORTUNITY_SOURCES } from '@acaos/backend-core/lib/opportunitySources.js'
import { isOpportunityDiscoveryEnabled } from '@acaos/backend-core/lib/opportunitySweep.js'
import { enqueueDiscoverOpportunities } from '@acaos/backend-core/lib/queues.js'
import type { Assert, Extends, UpdateDiscoveryProfileRequest, UpdateOpportunityStatusRequest, CreateJobFromOpportunityRequest } from '@acaos/shared'

// Work discovery ("Find work"): the workspace's discovery profile, the
// opportunities the scheduled sweep found (lib/opportunitySweep.ts), and the
// user's workflow on them. Reading and status changes are member-level; the
// profile and "run now" are admin (icp:update / prospects:discover); turning a
// won job into a Field Ops job site is ops:manage.
export const opportunitiesRouter = Router()
opportunitiesRouter.use(requireAuth)
opportunitiesRouter.use(requireVerifiedForMutation)

const SOURCE_NAMES = OPPORTUNITY_SOURCES.map(s => s.name) as [string, ...string[]]

const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })

type SourceStateRow = {
  source: string
  lastRunAt: Date | null
  lastSuccessAt: Date | null
  lastError: string | null
  lastWarning: string | null
  lastMatched: number
}

async function assertMember(userId: string, workspaceId: string) {
  if (!(await userBelongsToWorkspace(userId, workspaceId))) throw new ApiError(403, 'Access denied')
}

// GET /api/opportunities/profile — the profile (or null), plus the choices the
// settings form offers and each source's configuration and last-run health.
opportunitiesRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)
    await assertMember(user.id, workspaceId)

    const [profile, stateRows] = await Promise.all([
      prisma.discoveryProfile.findUnique({ where: { workspaceId } }),
      prisma.discoverySourceState.findMany({ where: { workspaceId } }),
    ])
    // Row type spelled out (not inferred) so the build also type-checks against
    // the offline Prisma stub, whose query results are untyped.
    const states = (stateRows as SourceStateRow[])
    res.json({
      profile,
      discoveryEnabled: isOpportunityDiscoveryEnabled(),
      trades: TRADES.map(t => ({ id: t.id, label: t.label })),
      regions: AU_REGIONS,
      sources: OPPORTUNITY_SOURCES.map(s => {
        const st = states.find(x => x.source === s.name)
        return {
          name: s.name,
          label: s.label,
          description: s.description,
          configured: s.isConfigured,
          lastRunAt: st?.lastRunAt ?? null,
          lastSuccessAt: st?.lastSuccessAt ?? null,
          lastError: st?.lastError ?? null,
          lastWarning: st?.lastWarning ?? null,
          lastMatched: st?.lastMatched ?? 0,
        }
      }),
    })
  })
)

const profileSchema = z.object({
  workspaceId: workspaceIdField,
  enabled: z.boolean().optional(),
  trades: z.array(z.enum(TRADE_IDS as [string, ...string[]])).max(TRADE_IDS.length),
  keywords: z.array(z.string().trim().min(2).max(40)).max(20).optional(),
  baseLat: z.number().min(-90).max(90).nullable().optional(),
  baseLng: z.number().min(-180).max(180).nullable().optional(),
  radiusKm: z.number().int().min(1).max(500).optional(),
  regions: z.array(z.enum(AU_REGIONS)).max(AU_REGIONS.length).optional(),
  minValue: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  sources: z.array(z.enum(SOURCE_NAMES)).max(SOURCE_NAMES.length),
}).refine(p => (p.baseLat == null) === (p.baseLng == null), { message: 'baseLat and baseLng must be set together', path: ['baseLng'] })
type _ProfileConforms = Assert<Extends<z.infer<typeof profileSchema>, UpdateDiscoveryProfileRequest>>

// PUT /api/opportunities/profile — create or replace the workspace's profile.
opportunitiesRouter.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const body = parseBody(profileSchema, req)
    await assertWorkspacePermission(user.id, body.workspaceId, 'icp:update')

    const data = {
      enabled: body.enabled ?? true,
      trades: [...new Set(body.trades)],
      keywords: [...new Set((body.keywords ?? []).map(k => k.toLowerCase()))],
      baseLat: body.baseLat ?? null,
      baseLng: body.baseLng ?? null,
      radiusKm: body.radiusKm ?? 50,
      regions: [...new Set(body.regions ?? [])],
      minValue: body.minValue ?? null,
      sources: [...new Set(body.sources)],
    }
    const profile = await prisma.discoveryProfile.upsert({
      where: { workspaceId: body.workspaceId },
      create: { workspaceId: body.workspaceId, ...data },
      update: data,
    })
    await recordAudit({
      workspaceId: body.workspaceId, actorUserId: user.id, type: 'discovery.profile_updated',
      entityType: 'discoveryProfile', entityId: profile.id,
      metadata: { trades: data.trades, regions: data.regions, sources: data.sources, radiusKm: data.radiusKm },
    })
    res.json({ profile })
  })
)

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

// GET /api/opportunities — best first. Without ?status, DISMISSED is hidden.
opportunitiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    await assertMember(user.id, q.workspaceId)
    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))

    const where = { workspaceId: q.workspaceId, ...(q.status ? { status: q.status } : { status: { not: 'DISMISSED' } }) }
    const [opportunities, total, grouped] = await Promise.all([
      prisma.opportunity.findMany({
        where,
        orderBy: [{ score: 'desc' }, { firstSeenAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, source: true, kind: true, title: true, description: true, address: true, locality: true,
          region: true, distanceKm: true, valueAmount: true, currency: true, publishedAt: true, sourceUrl: true,
          counterpartyName: true, counterpartyAbn: true, counterpartyEmail: true, counterpartyPhone: true, buyerName: true,
          score: true, matchedTrades: true, reasons: true, recommendedAction: true, status: true,
          opsJobSiteId: true, firstSeenAt: true, lastChangedAt: true,
        },
      }),
      prisma.opportunity.count({ where }),
      prisma.opportunity.groupBy({ by: ['status'], where: { workspaceId: q.workspaceId }, _count: { _all: true } }),
    ])
    const counts: Record<string, number> = {}
    for (const g of grouped) counts[g.status] = g._count._all
    res.json({ opportunities, counts, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

const idParamsSchema = z.object({ id: idField })

const statusSchema = z.object({
  workspaceId: workspaceIdField,
  status: z.enum(OPPORTUNITY_STATUSES),
})
type _StatusConforms = Assert<Extends<z.infer<typeof statusSchema>, UpdateOpportunityStatusRequest>>

// PATCH /api/opportunities/:id/status — the user's workflow on one opportunity.
// Won/lost is the outcome signal that later tunes discovery, so it's audited.
opportunitiesRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId, status } = parseBody(statusSchema, req)
    await assertMember(user.id, workspaceId)

    const existing = await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: { id: true, status: true } })
    if (!existing) throw new ApiError(404, 'Opportunity not found')
    if (existing.status !== status) {
      await prisma.opportunity.updateMany({
        where: { id, workspaceId },
        data: { status, statusChangedAt: new Date(), statusChangedByUserId: user.id },
      })
      await recordAudit({
        workspaceId, actorUserId: user.id, type: 'discovery.opportunity_status',
        entityType: 'opportunity', entityId: id, metadata: { from: existing.status, to: status },
      })
    }
    res.json({ success: true, status })
  })
)

const createJobSchema = z.object({
  workspaceId: workspaceIdField,
  jobCode: z.string().trim().min(1).max(64).optional(),
})
type _CreateJobConforms = Assert<Extends<z.infer<typeof createJobSchema>, CreateJobFromOpportunityRequest>>

// POST /api/opportunities/:id/create-job — turn a WON opportunity into a Field
// Ops job site, closing the loop from "found it" to "doing it".
opportunitiesRouter.post(
  '/:id/create-job',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId, jobCode } = parseBody(createJobSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const opp = await prisma.opportunity.findFirst({ where: { id, workspaceId } })
    if (!opp) throw new ApiError(404, 'Opportunity not found')
    if (opp.status !== 'WON') throw new ApiError(409, 'Mark the opportunity as won before creating a job')
    if (opp.opsJobSiteId) throw new ApiError(409, 'A job site was already created for this opportunity')

    const notes = [
      opp.counterpartyName ? `Client / head contractor: ${opp.counterpartyName}` : null,
      opp.buyerName ? `For: ${opp.buyerName}` : null,
      opp.sourceUrl ? `Source: ${opp.sourceUrl}` : null,
    ].filter(Boolean).join('\n')

    let jobSite
    try {
      jobSite = await prisma.$transaction(async (tx) => {
        const site = await tx.opsJobSite.create({
          data: {
            workspaceId,
            jobCode: jobCode ?? `OPP-${opp.id.slice(-6).toUpperCase()}`,
            siteName: opp.title.slice(0, 200),
            location: (opp.address ?? [opp.locality, opp.region].filter(Boolean).join(', ')).slice(0, 200) || null,
            lat: opp.lat, lng: opp.lng,
            status: 'ACTIVE',
            notes: notes.slice(0, 2000) || null,
          },
        })
        // Guarded so two concurrent clicks can't both link a site.
        const linked = await tx.opportunity.updateMany({ where: { id, workspaceId, opsJobSiteId: null }, data: { opsJobSiteId: site.id } })
        if (linked.count === 0) throw new ApiError(409, 'A job site was already created for this opportunity')
        return site
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ApiError(409, 'A job site with this job code already exists — choose another code')
      throw err
    }
    await recordAudit({
      workspaceId, actorUserId: user.id, type: 'discovery.job_created',
      entityType: 'opportunity', entityId: id, metadata: { opsJobSiteId: jobSite.id },
    })
    res.status(201).json({ jobSite })
  })
)

// POST /api/opportunities/run — sweep this workspace's sources now.
opportunitiesRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseBody(workspaceQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'prospects:discover')
    if (!isOpportunityDiscoveryEnabled()) throw new ApiError(503, 'Work discovery is turned off on this server (OPPORTUNITY_DISCOVERY_ENABLED)')
    const profile = await prisma.discoveryProfile.findUnique({ where: { workspaceId }, select: { enabled: true, sources: true } })
    if (!profile?.enabled || profile.sources.length === 0) throw new ApiError(409, 'Set up your discovery profile and choose at least one source first')
    await enqueueDiscoverOpportunities(workspaceId, req.id)
    res.status(202).json({ queued: true })
  })
)
