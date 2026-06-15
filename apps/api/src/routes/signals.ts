import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { calculateOpportunityScores, detectBuyingStage, calcWinProbability, freshnessState } from '../lib/signalEngine.js'
import type { RawSignal } from '../lib/signalEngine.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { buildSignalFingerprint } from './prospects.js'
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

  const user = (req as AuthedRequest).user
  if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
    throw new ApiError(403, 'Workspace access denied')
  }

  const where: Record<string, unknown> = { workspaceId }
  if (req.query.prospectId) where.prospectId = req.query.prospectId
  if (req.query.type) where.type = req.query.type

  const limit = Math.min(Number(req.query.limit ?? 100), 200)

  const signals = await prisma.signal.findMany({
    where,
    orderBy: { detectedAt: 'desc' },
    take: limit,
    include: { prospect: { select: { id: true, companyName: true } } }
  })

  // Attach the user-facing freshness state (decay-derived) so the UI can show
  // LIVE/RECENT/STALE/EXPIRED without recomputing decay client-side.
  const withFreshness = signals.map((s) => ({
    ...s,
    freshness: freshnessState({ type: s.type, detectedAt: s.detectedAt }),
  }))

  res.json({ signals: withFreshness })
}))

// POST /api/signals — add a manual signal
signalsRouter.post('/', asyncHandler(async (req, res) => {
  const { workspaceId, prospectId, type, strength, title, description, sourceUrl, source,
    sourceReliability, industryRelevance, detectedAt } = req.body

  if (!workspaceId || !prospectId) throw new ApiError(400, 'workspaceId and prospectId required')
  if (!type) throw new ApiError(400, 'type required')
  if (strength === undefined || strength < 0 || strength > 100) throw new ApiError(400, 'strength must be 0-100')

  const user = (req as AuthedRequest).user
  if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
    throw new ApiError(403, 'Workspace access denied')
  }

  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  if (prospect.workspaceId !== workspaceId) {
    throw new ApiError(403, 'Prospect does not belong to this workspace')
  }

  const resolvedSource = source ?? 'manual'
  const resolvedDetectedAt = detectedAt ? new Date(detectedAt) : new Date()
  const fp = buildSignalFingerprint(resolvedSource, type, title ?? null, resolvedDetectedAt)

  const signal = await prisma.signal.upsert({
    where: { prospectId_fingerprint: { prospectId, fingerprint: fp } },
    create: {
      workspaceId,
      prospectId,
      type,
      strength: Number(strength),
      sourceReliability: sourceReliability !== undefined ? Number(sourceReliability) : 70,
      industryRelevance: industryRelevance !== undefined ? Number(industryRelevance) : 50,
      title: title ?? null,
      description: description ?? null,
      sourceUrl: sourceUrl ?? null,
      source: resolvedSource,
      fingerprint: fp,
      detectedAt: resolvedDetectedAt,
    },
    update: {
      strength: Number(strength),
      detectedAt: resolvedDetectedAt,
    }
  })

  // Rescore the prospect
  const allSignals = await prisma.signal.findMany({ where: { prospectId } })
  const rawSignals = allSignals.map(toRawSignal)
  const scores = calculateOpportunityScores(rawSignals, {
    industry: prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail: prospect.contactEmail,
    contactName: prospect.contactName,
    domain: prospect.domain
  })
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

  const user = (req as AuthedRequest).user
  if (!(await userBelongsToWorkspace(user.id, signal.workspaceId))) {
    throw new ApiError(403, 'Workspace access denied')
  }

  await prisma.signal.delete({ where: { id: signalId } })
  res.json({ ok: true })
}))
