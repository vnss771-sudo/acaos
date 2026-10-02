import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { COMMERCIAL_EVENT_TYPES, OFFER_TRIGGERS } from '@acaos/backend-core/lib/offerModel.js'
import { COMMERCIAL_EVENT_KINDS } from '@acaos/backend-core/lib/commercialEventEngine.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../lib/validate.js'
import type { Assert, Extends, CreateOfferRequest, UpdateOfferRequest } from '@acaos/shared'

// Offers: what the workspace sells, explicitly (lib/offerModel.ts). The
// opportunity engine assesses prospects against these. Reading is member-level;
// changing an offer changes targeting strategy, so writes need icp:update.
export const offersRouter = Router()
offersRouter.use(requireAuth)
offersRouter.use(requireVerifiedForMutation)

async function assertMember(userId: string, workspaceId: string) {
  if (!(await userBelongsToWorkspace(userId, workspaceId))) throw new ApiError(403, 'Access denied')
}

const phrase = z.string().trim().min(2).max(80)
const phrases = z.array(phrase).max(30)
const cents = z.number().int().min(0).max(1_000_000_000_00)

const offerFields = {
  name: z.string().trim().min(2).max(120),
  missionId: idField.nullable().optional(),
  problemSolved: z.string().trim().max(1000).nullable().optional(),
  targetCustomer: z.string().trim().max(300).nullable().optional(),
  targetBuyerTitles: phrases.optional(),
  // A specific event kind (e.g. TENDER_OPPORTUNITY) or a whole family (e.g. ACTIVE_PROCUREMENT).
  triggeringEvents: z.array(z.enum(OFFER_TRIGGERS as unknown as [string, ...string[]])).max(OFFER_TRIGGERS.length).optional(),
  qualifyingKeywords: phrases.optional(),
  disqualifyingKeywords: phrases.optional(),
  geographies: z.array(z.string().trim().min(2).max(60)).max(30).optional(),
  minOpportunityValueCents: cents.nullable().optional(),
  dealValueMinCents: cents.nullable().optional(),
  dealValueMaxCents: cents.nullable().optional(),
  urgencyIndicators: phrases.optional(),
  proofPoints: z.array(z.string().trim().min(2).max(300)).max(20).optional(),
  recommendedActions: z.array(z.string().trim().min(2).max(200)).max(20).optional(),
  active: z.boolean().optional(),
}

function valueRangeOk(p: { dealValueMinCents?: number | null; dealValueMaxCents?: number | null }): boolean {
  return p.dealValueMinCents == null || p.dealValueMaxCents == null || p.dealValueMinCents <= p.dealValueMaxCents
}
const valueRangeMsg = { message: 'dealValueMinCents must not exceed dealValueMaxCents', path: ['dealValueMaxCents'] }

const createSchema = z.object({ workspaceId: workspaceIdField, ...offerFields }).refine(valueRangeOk, valueRangeMsg)
const updateSchema = z.object({ workspaceId: workspaceIdField, ...offerFields, name: offerFields.name.optional() }).refine(valueRangeOk, valueRangeMsg)
type _CreateConforms = Assert<Extends<z.infer<typeof createSchema>, CreateOfferRequest>>
type _UpdateConforms = Assert<Extends<z.infer<typeof updateSchema>, UpdateOfferRequest>>

const dedupe = (xs: string[] | undefined) => xs === undefined ? undefined : [...new Set(xs)]
const dedupeLower = (xs: string[] | undefined) => xs === undefined ? undefined : [...new Set(xs.map(x => x.toLowerCase()))]

function offerData(b: z.infer<typeof updateSchema>) {
  return {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.missionId !== undefined ? { missionId: b.missionId } : {}),
    ...(b.problemSolved !== undefined ? { problemSolved: b.problemSolved || null } : {}),
    ...(b.targetCustomer !== undefined ? { targetCustomer: b.targetCustomer || null } : {}),
    ...(b.targetBuyerTitles !== undefined ? { targetBuyerTitles: dedupe(b.targetBuyerTitles) } : {}),
    ...(b.triggeringEvents !== undefined ? { triggeringEvents: dedupe(b.triggeringEvents) } : {}),
    ...(b.qualifyingKeywords !== undefined ? { qualifyingKeywords: dedupeLower(b.qualifyingKeywords) } : {}),
    ...(b.disqualifyingKeywords !== undefined ? { disqualifyingKeywords: dedupeLower(b.disqualifyingKeywords) } : {}),
    ...(b.geographies !== undefined ? { geographies: dedupe(b.geographies) } : {}),
    ...(b.minOpportunityValueCents !== undefined ? { minOpportunityValueCents: b.minOpportunityValueCents } : {}),
    ...(b.dealValueMinCents !== undefined ? { dealValueMinCents: b.dealValueMinCents } : {}),
    ...(b.dealValueMaxCents !== undefined ? { dealValueMaxCents: b.dealValueMaxCents } : {}),
    ...(b.urgencyIndicators !== undefined ? { urgencyIndicators: dedupeLower(b.urgencyIndicators) } : {}),
    ...(b.proofPoints !== undefined ? { proofPoints: dedupe(b.proofPoints) } : {}),
    ...(b.recommendedActions !== undefined ? { recommendedActions: dedupe(b.recommendedActions) } : {}),
    ...(b.active !== undefined ? { active: b.active } : {}),
  }
}

async function assertMissionInWorkspace(missionId: string | null | undefined, workspaceId: string) {
  if (!missionId) return
  const m = await prisma.mission.findFirst({ where: { id: missionId, workspaceId }, select: { id: true } })
  if (!m) throw new ApiError(404, 'Mission not found')
}

// GET /api/offers — the workspace's offers, active first.
offersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(z.object({ workspaceId: workspaceIdField }), req)
    await assertMember(user.id, workspaceId)
    const offers = await prisma.offer.findMany({
      where: { workspaceId },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    })
    res.json({ offers, commercialEventKinds: COMMERCIAL_EVENT_KINDS, commercialEventFamilies: COMMERCIAL_EVENT_TYPES })
  })
)

// POST /api/offers
offersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const body = parseBody(createSchema, req)
    await assertWorkspacePermission(user.id, body.workspaceId, 'icp:update')
    await assertMissionInWorkspace(body.missionId, body.workspaceId)
    const offer = await prisma.offer.create({
      data: { workspaceId: body.workspaceId, name: body.name, ...offerData(body) },
    })
    await recordAudit({
      workspaceId: body.workspaceId, actorUserId: user.id, type: 'offer.created',
      entityType: 'offer', entityId: offer.id, metadata: { name: offer.name, missionId: offer.missionId },
    })
    res.status(201).json({ offer })
  })
)

const idParamsSchema = z.object({ id: idField })

// PUT /api/offers/:id — partial update.
offersRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const body = parseBody(updateSchema, req)
    await assertWorkspacePermission(user.id, body.workspaceId, 'icp:update')
    const existing = await prisma.offer.findFirst({ where: { id, workspaceId: body.workspaceId } })
    if (!existing) throw new ApiError(404, 'Offer not found')
    await assertMissionInWorkspace(body.missionId, body.workspaceId)
    const merged = {
      dealValueMinCents: body.dealValueMinCents !== undefined ? body.dealValueMinCents : existing.dealValueMinCents,
      dealValueMaxCents: body.dealValueMaxCents !== undefined ? body.dealValueMaxCents : existing.dealValueMaxCents,
    }
    if (!valueRangeOk(merged)) throw new ApiError(400, valueRangeMsg.message)
    const offer = await prisma.offer.update({ where: { id }, data: offerData(body) })
    await recordAudit({
      workspaceId: body.workspaceId, actorUserId: user.id, type: 'offer.updated',
      entityType: 'offer', entityId: id, metadata: { fields: Object.keys(offerData(body)) },
    })
    res.json({ offer })
  })
)

// DELETE /api/offers/:id?workspaceId= — its OPEN opportunities expire with it;
// operator-owned ones (pursuing/won/lost/dismissed) keep their history.
offersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(z.object({ workspaceId: workspaceIdField }), req)
    await assertWorkspacePermission(user.id, workspaceId, 'icp:update')
    const existing = await prisma.offer.findFirst({ where: { id, workspaceId }, select: { id: true, name: true } })
    if (!existing) throw new ApiError(404, 'Offer not found')
    const now = new Date()
    await prisma.$transaction([
      prisma.commercialOpportunity.updateMany({
        where: { workspaceId, offerKey: `offer:${id}`, status: 'OPEN' },
        data: { status: 'EXPIRED', statusChangedAt: now, statusChangedByUserId: user.id },
      }),
      prisma.offer.deleteMany({ where: { id, workspaceId } }),
    ])
    await recordAudit({
      workspaceId, actorUserId: user.id, type: 'offer.deleted',
      entityType: 'offer', entityId: id, metadata: { name: existing.name },
    })
    res.json({ success: true })
  })
)
