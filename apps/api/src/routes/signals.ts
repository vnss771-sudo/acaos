import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
} from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const signalsRouter = Router()
signalsRouter.use(requireAuth)

// GET /api/signals?workspaceId=&prospectId=&type=
signalsRouter.get('/', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const where: Record<string, unknown> = { workspaceId }
  if (req.query.prospectId) where.prospectId = req.query.prospectId
  if (req.query.type)       where.type       = req.query.type

  const signals = await prisma.signal.findMany({
    where,
    orderBy: { detectedAt: 'desc' },
    take: 100,
  })

  res.json({ signals })
}))

// POST /api/signals — add a manual signal
signalsRouter.post('/', asyncHandler(async (req, res) => {
  const {
    workspaceId, prospectId, type, strength, title, description,
    sourceUrl, source, sourceReliability, industryRelevance, detectedAt,
  } = req.body

  if (!workspaceId || !prospectId) throw new ApiError(400, 'workspaceId and prospectId required')
  if (!type)                       throw new ApiError(400, 'type required')
  if (strength === undefined || strength < 0 || strength > 100) throw new ApiError(400, 'strength must be 0-100')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  // Validate date before storing — new Date('garbage') produces Invalid Date silently
  let resolvedDate: Date
  if (detectedAt) {
    const parsed = new Date(detectedAt)
    if (isNaN(parsed.getTime())) throw new ApiError(400, 'detectedAt must be a valid ISO 8601 date')
    resolvedDate = parsed
  } else {
    resolvedDate = new Date()
  }

  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect)                             throw new ApiError(404, 'Prospect not found')
  if (prospect.workspaceId !== workspaceId)  throw new ApiError(403, 'Prospect does not belong to workspace')

  // Fetch existing signals before creating new one
  const existingSignals = await prisma.signal.findMany({ where: { prospectId } })

  const signal = await prisma.signal.create({
    data: {
      workspaceId,
      prospectId,
      type,
      strength:          Number(strength),
      sourceReliability: sourceReliability !== undefined ? Number(sourceReliability) : 70,
      industryRelevance: industryRelevance !== undefined ? Number(industryRelevance) : 50,
      title:       title       ?? null,
      description: description ?? null,
      sourceUrl:   sourceUrl   ?? null,
      source:      source      ?? 'manual',
      detectedAt:  resolvedDate,
    },
  })

  // Rescore using existing signals + the new one (avoids a second DB round-trip)
  const allSignals = [...existingSignals, signal].map(toRawSignal)

  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  const icpConfig = icp ? {
    targetIndustries: icp.targetIndustries,
    minEmployees:     icp.minEmployees ?? undefined,
    maxEmployees:     icp.maxEmployees ?? undefined,
    targetGeos:       icp.targetGeos,
    mustHaveEmail:    icp.mustHaveEmail,
  } : undefined

  const scores = calculateOpportunityScores(allSignals, {
    industry:     prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail: prospect.contactEmail,
    contactName:  prospect.contactName,
    domain:       prospect.domain,
    location:     prospect.location,
  }, icpConfig)

  const buyingStage    = detectBuyingStage(allSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  await prisma.prospect.update({
    where: { id: prospectId },
    data: { ...scores, buyingStage, winProbability, lastSignalAt: signal.detectedAt },
  })

  res.status(201).json(signal)
}))

// DELETE /api/signals/:id
signalsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const signal = await prisma.signal.findUnique({ where: { id: req.params.id } })
  if (!signal) throw new ApiError(404, 'Signal not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, signal.workspaceId)) throw new ApiError(403, 'Access denied')

  await prisma.signal.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
}))
