import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { calculateOpportunityScores, detectBuyingStage, calcWinProbability } from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import type { RawSignal } from '../lib/signalEngine.js'
import type { AuthedRequest } from '../types/auth.js'

export const signalsRouter = Router()
signalsRouter.use(requireAuth)

function toRawSignal(s: { type: string; strength: number; sourceReliability: number; industryRelevance: number; detectedAt: Date }): RawSignal {
  return { type: s.type as RawSignal['type'], strength: s.strength, sourceReliability: s.sourceReliability, industryRelevance: s.industryRelevance, detectedAt: s.detectedAt }
}

// GET /api/signals?workspaceId=&prospectId=&type=
signalsRouter.get('/', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const where: Record<string, unknown> = { workspaceId }
  if (req.query.prospectId) where.prospectId = req.query.prospectId
  if (req.query.type) where.type = req.query.type

  const signals = await prisma.signal.findMany({
    where,
    orderBy: { detectedAt: 'desc' },
    take: 100
  })

  res.json({ signals })
}))

// POST /api/signals — add a manual signal
signalsRouter.post('/', asyncHandler(async (req, res) => {
  const { workspaceId, prospectId, type, strength, title, description, sourceUrl, source,
    sourceReliability, industryRelevance, detectedAt } = req.body

  if (!workspaceId || !prospectId) throw new ApiError(400, 'workspaceId and prospectId required')
  if (!type) throw new ApiError(400, 'type required')
  if (strength === undefined || strength < 0 || strength > 100) throw new ApiError(400, 'strength must be 0-100')

  // Verify workspace membership
  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  // Verify prospect belongs to the claimed workspace (IDOR guard)
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  if (prospect.workspaceId !== workspaceId) throw new ApiError(403, 'Access denied')

  const signal = await prisma.signal.create({
    data: {
      workspaceId,
      prospectId,
      type,
      strength: Number(strength),
      sourceReliability: sourceReliability !== undefined ? Number(sourceReliability) : 70,
      industryRelevance: industryRelevance !== undefined ? Number(industryRelevance) : 50,
      title: title ?? null,
      description: description ?? null,
      sourceUrl: sourceUrl ?? null,
      source: source ?? 'manual',
      detectedAt: detectedAt ? new Date(detectedAt) : new Date(),
    }
  })

  // Rescore the prospect — fetch ICP to make fit score workspace-aware
  const [allSignals, icp] = await Promise.all([
    prisma.signal.findMany({ where: { prospectId } }),
    prisma.workspaceICP.findUnique({ where: { workspaceId } })
  ])
  const rawSignals = allSignals.map(toRawSignal)
  const scores = calculateOpportunityScores(rawSignals, {
    industry: prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail: prospect.contactEmail,
    contactName: prospect.contactName,
    domain: prospect.domain
  }, icp)
  const buyingStage = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  await prisma.prospect.update({
    where: { id: prospectId },
    data: { ...scores, buyingStage, winProbability, lastSignalAt: signal.detectedAt }
  })

  res.status(201).json(signal)
}))

// DELETE /api/signals/:id
signalsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const signalId = req.params.id as string
  const signal = await prisma.signal.findUnique({ where: { id: signalId } })
  if (!signal) throw new ApiError(404, 'Signal not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, signal.workspaceId)) throw new ApiError(403, 'Access denied')

  await prisma.signal.delete({ where: { id: signalId } })
  res.json({ ok: true })
}))
