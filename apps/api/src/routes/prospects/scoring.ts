import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  getOpportunityTier,
  toRawSignal,
} from '../../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../../lib/workspaces.js'
import { enqueueScoreProspects, enqueueCalibrate } from '../../lib/queues.js'
import { evidenceGatedPriority } from '../../lib/recommendationPolicy.js'
import { createOutreachIntentForRecommendation } from '../../lib/outreachIntent.js'
import { dollarsToCents, centsToDollars } from '../../lib/money.js'
import { withDollars, getICP } from './helpers.js'

export function registerScoringRoutes(prospectsRouter: Router) {
  // POST /api/prospects/:id/rescore
  prospectsRouter.post('/:id/rescore', asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({
      where: { id: req.params.id as string },
      include: { signals: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = req.user!.id
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
  prospectsRouter.post('/:id/outcome', asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = req.user!.id
    if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

    // Example prospects are fictional — recording outcomes against them would feed
    // demo data into the forecast and the scoring calibration loop.
    if (prospect.isExample) throw new ApiError(400, 'Example prospects cannot have outcomes — add real prospects first')

    if (!req.body.stage) throw new ApiError(400, 'stage required')

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
      enqueueScoreProspects(prospect.workspaceId).catch(() => {})
      enqueueCalibrate(prospect.workspaceId).catch(() => {})
    }

    res.json({
      outcome: { ...outcome, dealValue: centsToDollars(outcome.dealValue) },
      prospect: withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }),
    })
  }))

  // POST /api/prospects/:id/recommend
  prospectsRouter.post('/:id/recommend', asyncHandler(async (req, res) => {
    const prospect = await prisma.prospect.findUnique({
      where: { id: req.params.id as string },
      include: { signals: true },
    })
    if (!prospect) throw new ApiError(404, 'Prospect not found')

    const userId = req.user!.id
    if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

    const rawSignals = prospect.signals.map(toRawSignal)
    const rec = generateRuleBasedRecommendation(
      {
        industry:      prospect.industry,
        employeeCount: prospect.employeeCount,
        contactEmail:  prospect.contactEmail,
        contactName:   prospect.contactName,
        contactPhone:  prospect.contactPhone,
        linkedinUrl:   prospect.linkedinUrl,
        domain:        prospect.domain,
        location:      prospect.location,
      },
      rawSignals
    )

    // Evidence-first gate: high-confidence priority requires provable, fresh
    // evidence on a signal — otherwise it's capped below the high-confidence line.
    const priority = evidenceGatedPriority(rec.priority, prospect.signals)

    const recommendation = await prisma.recommendation.create({
      data: {
        workspaceId: prospect.workspaceId,
        prospectId:  prospect.id,
        ...rec,
        priority,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    })

    // Bridge (Stage 2): carry this recommendation into the outreach spine as an
    // OutreachIntent with an evidence snapshot. Best-effort — additive.
    await createOutreachIntentForRecommendation({
      workspaceId: prospect.workspaceId,
      prospectId:  prospect.id,
      recommendationId: recommendation.id,
      messageAngle: rec.messageAngle,
      channel: rec.bestChannel,
      signals: prospect.signals,
      missionId: prospect.missionId,
    }).catch(() => {})

    res.status(201).json(recommendation)
  }))
}
