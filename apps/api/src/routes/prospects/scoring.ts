import type { Router } from 'express'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  toRawSignal,
} from '@acaos/backend-core/lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../../lib/workspaces.js'
import { enqueueScoreProspects, enqueueCalibrate } from '@acaos/backend-core/lib/queues.js'
import { recommendProspect, loadProspectWithSignals } from '../../lib/recommendProspect.js'
import { dollarsToCents, centsToDollars } from '../../lib/money.js'
import { prospectTenantScope, withDollars, getICP } from './helpers.js'
import { validate, parseParams, idField } from '../../lib/validate.js'
import { z } from 'zod'

const prospectParamsSchema = z.object({ id: idField })

// POST /:id/outcome body. stage required (the prior `if (!stage) 400`); notes
// optional; dealValue optional and accepted as a number or numeric string (the
// handler runs it through Number() then dollarsToCents()).
const outcomeBodySchema = z.object({
  stage: z.string().min(1, 'stage required'),
  notes: z.string().optional(),
  dealValue: z.union([z.number(), z.string()]).optional(),
})

export function registerScoringRoutes(prospectsRouter: Router) {
  // POST /api/prospects/:id/rescore
  prospectsRouter.post('/:id/rescore', prospectTenantScope, asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({
      where: { id: req.params.id as string },
      include: { signals: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = requireUser(req).id
    if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

    const rawSignals     = prospect.signals.map(toRawSignal)
    const icp            = await getICP(prospect.workspaceId)
    const scores         = calculateOpportunityScores(rawSignals, {
      industry:      prospect.industry,
      employeeCount: prospect.employeeCount,
      contactEmail:  prospect.contactEmail,
      contactName:   prospect.contactName,
      domain:        prospect.domain,
      location:      prospect.location,
    }, icp)
    const buyingStage    = detectBuyingStage(rawSignals, scores.opportunityScore)
    const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

    const updated = await prisma.prospect.update({
      where: { id: req.params.id as string },
      data: { ...scores, buyingStage, winProbability },
    })
    res.json(withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }))
  }))

  // POST /api/prospects/:id/outcome
  prospectsRouter.post('/:id/outcome', prospectTenantScope, validate(outcomeBodySchema), asyncHandler(async (req, res) => {
    const { id } = parseParams(prospectParamsSchema, req)
    const prospect = await prisma.prospect.findUnique({ where: { id } })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = requireUser(req).id
    if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

    // Example prospects are fictional — recording outcomes against them would feed
    // demo data into the forecast and the scoring calibration loop.
    if (prospect.isExample) throw new ApiError(400, 'Example prospects cannot have outcomes — add real prospects first')

    const [outcome, updated] = await prisma.$transaction([
      prisma.prospectOutcome.create({
        data: {
          workspaceId: prospect.workspaceId,
          prospectId:  prospect.id,
          stage:       req.body.stage,
          notes:       req.body.notes     ?? null,
          dealValue:   req.body.dealValue ? dollarsToCents(Number(req.body.dealValue)) : null,
        },
      }),
      prisma.prospect.update({
        where: { id: prospect.id },
        data: {
          outcomeStage: req.body.stage,
          lastContactedAt: ['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'].includes(req.body.stage)
            ? new Date() : undefined,
        },
      }),
    ])

    // Trigger background jobs on definitive outcomes
    if (['WON', 'LOST'].includes(req.body.stage)) {
      enqueueScoreProspects(prospect.workspaceId, req.id).catch(() => {})
      enqueueCalibrate(prospect.workspaceId, req.id).catch(() => {})
    }

    res.json({
      outcome: { ...outcome, dealValue: centsToDollars(outcome.dealValue) },
      prospect: withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }),
    })
  }))

  // POST /api/prospects/:id/recommend
  prospectsRouter.post('/:id/recommend', prospectTenantScope, asyncHandler(async (req, res) => {
    const prospect = await loadProspectWithSignals(req.params.id as string)
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = requireUser(req).id
    if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

    const { recommendation } = await recommendProspect(prospect)
    res.status(201).json(recommendation)
  }))
}
