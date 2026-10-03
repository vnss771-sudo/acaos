import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { COMMERCIAL_OPPORTUNITY_STATUSES, bridgesRecommendation, refreshCommercialOpportunities, retireBridge } from '@acaos/backend-core/lib/commercialOpportunityStore.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { proposeIntentForOpportunity } from '@acaos/backend-core/lib/opportunityIntent.js'
import { loadOutcomeChain, loadOutcomeSummary } from '@acaos/backend-core/lib/outcomeGraphStore.js'
import { loadCalibration } from '@acaos/backend-core/lib/calibrationLearning.js'
import { loadNetworkBenchmarks, NetworkAccessError, setNetworkParticipation } from '@acaos/backend-core/lib/networkIntelligence.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../lib/validate.js'
import type { Assert, Extends, UpdateCommercialOpportunityStatusRequest, RefreshCommercialOpportunitiesRequest, ProposeOpportunityIntentRequest, NetworkParticipationRequest } from '@acaos/shared'

// Commercial opportunities (lib/opportunityEngine.ts): one per (prospect, offer),
// each with its evidence, confidence, offer fit and recommended action. Reading
// and the operator's status workflow are member-level; a workspace-wide
// reassessment is admin (prospects:discover).
export const commercialOpportunitiesRouter = Router()
commercialOpportunitiesRouter.use(requireAuth)
commercialOpportunitiesRouter.use(requireVerifiedForMutation)

async function assertMember(userId: string, workspaceId: string) {
  if (!(await userBelongsToWorkspace(userId, workspaceId))) throw new ApiError(403, 'Access denied')
}

const ORDER_BY = {
  priority: [{ priority: 'desc' as const }, { confidence: 'desc' as const }, { id: 'asc' as const }],
  expectedValue: [{ expectedValueCents: { sort: 'desc' as const, nulls: 'last' as const } }, { priority: 'desc' as const }, { id: 'asc' as const }],
  confidence: [{ confidence: 'desc' as const }, { priority: 'desc' as const }, { id: 'asc' as const }],
}

/** Statuses hidden from the default list: closed out by the operator or the engine. */
const HIDDEN_BY_DEFAULT = ['DISMISSED', 'EXPIRED']

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  status: z.enum(COMMERCIAL_OPPORTUNITY_STATUSES).optional(),
  prospectId: idField.optional(),
  // priority (default): value × probability × urgency. expectedValue: value ×
  // probability (unknown values last). confidence: how sure the event is real.
  sort: z.enum(['priority', 'expectedValue', 'confidence']).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

const LIST_SELECT = {
  id: true, prospectId: true, offerId: true, missionId: true, offerKey: true,
  eventType: true, eventTitle: true, whyNow: true, confidence: true, evidenceConfidence: true,
  independentSources: true, offerFit: true, intentScore: true, timingScore: true, contactability: true,
  competition: true, valueScore: true, expectedValueCents: true,
  estimatedValueMinCents: true, estimatedValueMaxCents: true, probability: true, urgency: true,
  priority: true, buyingStage: true, recommendedBuyer: true, recommendedAction: true, actionLabel: true, recommendationKind: true,
  actionReason: true, intelligenceGate: true, status: true, firstDetectedAt: true, lastAssessedAt: true,
  prospect: { select: { id: true, companyName: true, domain: true } },
  offer: { select: { id: true, name: true } },
}

// GET /api/commercial-opportunities — highest priority first (or ?sort=
// expectedValue | confidence). Without ?status, DISMISSED and EXPIRED are hidden.
commercialOpportunitiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    await assertMember(user.id, q.workspaceId)
    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))

    const where = {
      workspaceId: q.workspaceId,
      ...(q.prospectId ? { prospectId: q.prospectId } : {}),
      ...(q.status ? { status: q.status } : { status: { notIn: HIDDEN_BY_DEFAULT } }),
    }
    const [opportunities, total, grouped] = await Promise.all([
      prisma.commercialOpportunity.findMany({
        where,
        orderBy: ORDER_BY[q.sort ?? 'priority'],
        skip: (page - 1) * limit,
        take: limit,
        select: LIST_SELECT,
      }),
      prisma.commercialOpportunity.count({ where }),
      prisma.commercialOpportunity.groupBy({ by: ['status'], where: { workspaceId: q.workspaceId }, _count: { _all: true } }),
    ])
    const counts: Record<string, number> = {}
    for (const g of grouped) counts[g.status] = g._count._all
    res.json({ opportunities, counts, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

// GET /api/commercial-opportunities/outcomes — the outcome funnel (detected →
// sent → replied → meeting → quoted → won/lost) and won revenue split by
// attribution (sourced by an ACAOS send vs influenced), and counts per cause. ?since= limits it to
// opportunities first detected on or after that date. Registered before /:id.
commercialOpportunitiesRouter.get(
  '/outcomes',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(z.object({ workspaceId: workspaceIdField, since: z.coerce.date().optional() }), req)
    await assertMember(user.id, q.workspaceId)
    res.json({ summary: await loadOutcomeSummary(q.workspaceId, { since: q.since }) })
  })
)

// GET /api/commercial-opportunities/calibration — which event kinds turn into
// revenue: the funnel per kind, combination lift, the approved weights and what
// calibration would propose now. Read-only; proposals go through learning.
commercialOpportunitiesRouter.get(
  '/calibration',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(z.object({ workspaceId: workspaceIdField }), req)
    await assertMember(user.id, workspaceId)
    res.json(await loadCalibration(workspaceId))
  })
)

// GET /api/commercial-opportunities/network-benchmarks — pooled, anonymised win
// rates per event kind across opted-in workspaces, beside this workspace's own.
// Only an opted-in workspace may read them (403 otherwise).
commercialOpportunitiesRouter.get(
  '/network-benchmarks',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(z.object({ workspaceId: workspaceIdField }), req)
    await assertMember(user.id, workspaceId)
    try {
      res.json(await loadNetworkBenchmarks(workspaceId))
    } catch (e) {
      if (e instanceof NetworkAccessError) throw new ApiError(e.status, e.message)
      throw e
    }
  })
)

const participationSchema = z.object({ workspaceId: workspaceIdField, optIn: z.boolean() })
type _ParticipationConforms = Assert<Extends<z.infer<typeof participationSchema>, NetworkParticipationRequest>>

// PUT /api/commercial-opportunities/network-participation — an admin opts the
// workspace in to (or out of) cross-customer intelligence. Audited.
commercialOpportunitiesRouter.put(
  '/network-participation',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, optIn } = parseBody(participationSchema, req)
    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')
    const result = await setNetworkParticipation(workspaceId, optIn)
    await recordAudit({
      workspaceId, actorUserId: user.id, type: optIn ? 'network.opt_in' : 'network.opt_out',
      entityType: 'workspace', entityId: workspaceId, metadata: { optedInAt: result.optedInAt },
    })
    res.json(result)
  })
)

const idParamsSchema = z.object({ id: idField })

// GET /api/commercial-opportunities/:id/outcome — the opportunity's chain:
// recommendation → intent → outreach → reply → meeting → quote → won/lost → revenue,
// plus the cause it closed or stalled (lib/outcomeCauses.ts; null when won or open).
commercialOpportunitiesRouter.get(
  '/:id/outcome',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(z.object({ workspaceId: workspaceIdField }), req)
    await assertMember(user.id, workspaceId)
    const result = await loadOutcomeChain(workspaceId, id)
    if (!result) throw new ApiError(404, 'Opportunity not found')
    res.json(result)
  })
)

// GET /api/commercial-opportunities/:id — full record: evidence claims, reasons,
// blockers and signal velocity.
commercialOpportunitiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(z.object({ workspaceId: workspaceIdField }), req)
    await assertMember(user.id, workspaceId)
    const opportunity = await prisma.commercialOpportunity.findFirst({
      where: { id, workspaceId },
      include: {
        prospect: { select: { id: true, companyName: true, domain: true, contactName: true, contactTitle: true, contactEmail: true } },
        offer: { select: { id: true, name: true, proofPoints: true, recommendedActions: true } },
      },
    })
    if (!opportunity) throw new ApiError(404, 'Opportunity not found')
    res.json({ opportunity })
  })
)

const statusSchema = z.object({
  workspaceId: workspaceIdField,
  // EXPIRED is the engine's to set; an operator can re-open (OPEN) or decide.
  status: z.enum(['OPEN', 'PURSUING', 'WON', 'LOST', 'DISMISSED']),
})
type _StatusConforms = Assert<Extends<z.infer<typeof statusSchema>, UpdateCommercialOpportunityStatusRequest>>

// PATCH /api/commercial-opportunities/:id/status — the operator's decision.
// Won/lost is the outcome the learning loop will calibrate on, so it's audited.
commercialOpportunitiesRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId, status } = parseBody(statusSchema, req)
    await assertMember(user.id, workspaceId)
    const existing = await prisma.commercialOpportunity.findFirst({ where: { id, workspaceId }, select: { id: true, status: true } })
    if (!existing) throw new ApiError(404, 'Opportunity not found')
    if (existing.status !== status) {
      await prisma.commercialOpportunity.updateMany({
        where: { id, workspaceId },
        data: { status, statusChangedAt: new Date(), statusChangedByUserId: user.id },
      })
      // A decided opportunity's outreach recommendation no longer stands.
      if (!bridgesRecommendation(status)) await retireBridge(workspaceId, id, new Date())
      await recordAudit({
        workspaceId, actorUserId: user.id, type: 'commercial_opportunity.status',
        entityType: 'commercialOpportunity', entityId: id, metadata: { from: existing.status, to: status },
      })
    }
    res.json({ success: true, status })
  })
)

const refreshSchema = z.object({
  workspaceId: workspaceIdField,
  prospectId: idField.optional(),
})
type _RefreshConforms = Assert<Extends<z.infer<typeof refreshSchema>, RefreshCommercialOpportunitiesRequest>>

/** Upper bound on prospects reassessed by one workspace-wide request. */
const MAX_REFRESH_PROSPECTS = 500

// POST /api/commercial-opportunities/refresh — reassess one prospect (member) or
// the most recently signalled prospects in the workspace (admin), now — e.g.
// right after an offer changed, instead of waiting for the next rescore.
commercialOpportunitiesRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, prospectId } = parseBody(refreshSchema, req)
    let ids: string[]
    if (prospectId) {
      await assertMember(user.id, workspaceId)
      const p = await prisma.prospect.findFirst({ where: { id: prospectId, workspaceId }, select: { id: true } })
      if (!p) throw new ApiError(404, 'Prospect not found')
      ids = [p.id]
    } else {
      await assertWorkspacePermission(user.id, workspaceId, 'prospects:discover')
      // Same candidates the store reassesses: a recent signal, or an OPEN
      // opportunity / ACTIVE event that may need retiring. (lastSignalAt isn't set on every
      // ingest path, so it can't be the filter.)
      const cutoff = new Date(Date.now() - 30 * 86_400_000)
      const rows = await prisma.prospect.findMany({
        where: {
          workspaceId, isExample: false,
          OR: [
            { signals: { some: { detectedAt: { gte: cutoff } } } },
            { commercialOpportunities: { some: { status: 'OPEN' } } },
            { commercialEvents: { some: { status: 'ACTIVE' } } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: MAX_REFRESH_PROSPECTS,
        select: { id: true },
      })
      // Row type spelled out so the build also type-checks against the offline
      // Prisma stub, whose query results are untyped.
      ids = (rows as Array<{ id: string }>).map(r => r.id)
    }
    const result = await refreshCommercialOpportunities(workspaceId, ids)
    res.json(result)
  })
)

const proposeIntentSchema = z.object({ workspaceId: workspaceIdField })
type _ProposeIntentConforms = Assert<Extends<z.infer<typeof proposeIntentSchema>, ProposeOpportunityIntentRequest>>

// POST /api/commercial-opportunities/:id/intent — turn the opportunity's live
// outreach recommendation into a PROPOSED OutreachIntent carrying its evidence
// and grounding record. Admin, like every other intent write. Nothing is sent:
// draft → approve → materialise → send stays the existing, gated path.
// Idempotent: 201 when created, 200 with the existing intent otherwise.
commercialOpportunitiesRouter.post(
  '/:id/intent',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseBody(proposeIntentSchema, req)
    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')
    const result = await proposeIntentForOpportunity({ workspaceId, opportunityId: id })
    if (!result.ok) throw new ApiError(result.status, result.error)
    if (result.created) {
      await recordAudit({
        workspaceId, actorUserId: user.id, type: 'outreachIntent.propose',
        entityType: 'outreachIntent', entityId: result.intentId, metadata: { commercialOpportunityId: id },
      })
    }
    res.status(result.created ? 201 : 200).json(result)
  })
)
