import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { prisma } from '../../lib/prisma.js'
import { userHasWorkspaceAccess, assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { buildIntentDraftInput } from '../../lib/outreachIntent.js'
import { materializeOutreachIntent } from '../../lib/materializeIntent.js'
import { generateOutreach } from '../../services/openai.js'
import { parseAiJson, OutreachDraftOutputSchema } from '@acaos/backend-core/lib/aiSchemas.js'
import { loadIntentForWrite } from './helpers.js'
import { parseBody, parseParams, idField } from '../../lib/validate.js'
import { z } from 'zod'

// Route params for the /:id/intents/:intentId/* endpoints.
const intentParamsSchema = z.object({ id: idField, intentId: idField })
// approve: optional leadId (the handler trims and verifies workspace ownership).
const approveIntentSchema = z.object({ leadId: z.string().optional() })
// materialize: optional campaignId (same handling).
const materializeIntentSchema = z.object({ campaignId: z.string().optional() })

export function registerIntentRoutes(prospectsRouter: Router) {
  // GET /api/prospects/:id/intents — read-only view of the bridge records for a
  // prospect (Stage 2): recommendation → outreach intent with evidence snapshot.
  prospectsRouter.get('/:id/intents', asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, workspaceId: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = req.user!.id
    if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

    const intents = await prisma.outreachIntent.findMany({
      where: { prospectId: prospect.id },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ intents })
  }))

  // POST /api/prospects/:id/intents/:intentId/draft — Stage 3: generate the
  // outreach draft FROM the intent's evidence context and store it on the intent.
  prospectsRouter.post('/:id/intents/:intentId/draft', asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, workspaceId: true, companyName: true, industry: true, contactName: true, location: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, prospect.workspaceId, 'admin')

    const intent = await prisma.outreachIntent.findUnique({ where: { id: req.params.intentId as string } })
    if (!intent || intent.prospectId !== prospect.id) throw new ApiError(404, 'Outreach intent not found')

    const [recommendation, icpRow, missionCtx] = await Promise.all([
      intent.recommendationId
        ? prisma.recommendation.findUnique({ where: { id: intent.recommendationId }, select: { reasoning: true, messageAngle: true } })
        : Promise.resolve(null),
      prisma.workspaceICP.findUnique({ where: { workspaceId: prospect.workspaceId }, select: { targetIndustries: true, businessType: true, outreachTone: true } }),
      // Per-mission override (offer + target customer) when the intent belongs to a mission.
      intent.missionId
        ? prisma.mission.findUnique({ where: { id: intent.missionId }, select: { targetCustomer: true, offer: true } })
        : Promise.resolve(null),
    ])
    const icp = (icpRow || missionCtx)
      ? {
          targetIndustries: icpRow?.targetIndustries,
          businessType: icpRow?.businessType ?? undefined,
          outreachTone: icpRow?.outreachTone ?? undefined,
          offer: missionCtx?.offer ?? undefined,
          targetCustomer: missionCtx?.targetCustomer ?? undefined,
        }
      : undefined

    const raw = await generateOutreach(buildIntentDraftInput({ prospect, recommendation, intent, icp }))
    // Strict, schema-validated parse — fails closed with a 502 (AiSchemaError
    // extends ApiError) if the model returns bad JSON or omits subject/email.
    const parsed = parseAiJson(OutreachDraftOutputSchema, raw, 'intent-draft')

    const updated = await prisma.outreachIntent.update({
      where: { id: intent.id },
      data: {
        draftSubject: parsed.subject,
        draftBody: parsed.email,
        draftFollowup: parsed.followup ?? null,
        draftGeneratedAt: new Date(),
        status: 'DRAFTED',
      },
    })
    res.json(updated)
  }))

  // Stage 4: approve/reject an intent's drafted outreach. Approval locks the
  // evidence + text already captured on the intent (the auditable snapshot).
  prospectsRouter.post('/:id/intents/:intentId/approve', asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const { id, intentId } = parseParams(intentParamsSchema, req)
    const { leadId: rawLeadId } = parseBody(approveIntentSchema, { body: req.body ?? {} })
    const intent = await loadIntentForWrite(id, intentId, userId)
    if (intent.status !== 'DRAFTED') {
      throw new ApiError(409, `Cannot approve an intent that is ${intent.status.toLowerCase()} — generate a draft first`)
    }
    // Optionally link the intent to a lead so the send path can stamp its
    // provenance onto the resulting OutreachSent (Stage 5).
    const leadId = typeof rawLeadId === 'string' ? rawLeadId.trim() : undefined
    if (leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { workspaceId: true } })
      if (!lead || lead.workspaceId !== intent.workspaceId) throw new ApiError(400, 'leadId does not belong to this workspace')
    }
    const updated = await prisma.outreachIntent.update({
      where: { id: intent.id },
      data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date(), ...(leadId ? { leadId } : {}) },
    })
    void recordAudit({
      workspaceId: intent.workspaceId, actorUserId: userId,
      type: 'outreachIntent.approve', entityType: 'outreachIntent', entityId: intent.id,
      metadata: { prospectId: intent.prospectId },
    })
    res.json(updated)
  }))

  prospectsRouter.post('/:id/intents/:intentId/reject', asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const intent = await loadIntentForWrite(req.params.id as string, req.params.intentId as string, userId)
    if (['SENT', 'WON', 'LOST'].includes(intent.status)) {
      throw new ApiError(409, `Cannot reject a ${intent.status.toLowerCase()} intent`)
    }
    const updated = await prisma.outreachIntent.update({ where: { id: intent.id }, data: { status: 'REJECTED' } })
    void recordAudit({
      workspaceId: intent.workspaceId, actorUserId: userId,
      type: 'outreachIntent.reject', entityType: 'outreachIntent', entityId: intent.id,
      metadata: { prospectId: intent.prospectId },
    })
    res.json(updated)
  }))

  // Stage 5 / Option A: materialise an APPROVED intent into a sendable Lead +
  // APPROVED draft in a campaign, linked back to the intent. After this, launch
  // the campaign via the normal send path (which stamps provenance + flips SENT).
  prospectsRouter.post('/:id/intents/:intentId/materialize', asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const { id, intentId } = parseParams(intentParamsSchema, req)
    const { campaignId: rawCampaignId } = parseBody(materializeIntentSchema, { body: req.body ?? {} })
    const intent = await loadIntentForWrite(id, intentId, userId)
    if (intent.status !== 'APPROVED') {
      throw new ApiError(409, `Intent must be approved before sending — it is ${intent.status.toLowerCase()}`)
    }
    if (!intent.draftBody) throw new ApiError(409, 'Intent has no drafted message to send')

    const prospect = await prisma.prospect.findUnique({
      where: { id: intent.prospectId },
      select: { companyName: true, contactEmail: true, contactName: true, domain: true, location: true, industry: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')
    if (!prospect.contactEmail) throw new ApiError(400, 'Prospect has no contact email — cannot create a sendable lead')

    const campaignId = typeof rawCampaignId === 'string' ? rawCampaignId.trim() : undefined
    if (campaignId) {
      const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true } })
      if (!c || c.workspaceId !== intent.workspaceId) throw new ApiError(400, 'campaignId does not belong to this workspace')
    }

    const result = await materializeOutreachIntent({ intent, prospect, campaignId })
    void recordAudit({
      workspaceId: intent.workspaceId, actorUserId: userId,
      type: 'outreachIntent.materialize', entityType: 'outreachIntent', entityId: intent.id,
      metadata: result,
    })
    res.status(201).json({ ...result, message: `Intent materialised — launch campaign ${result.campaignId} to send (approval-mode safe).` })
  }))
}
