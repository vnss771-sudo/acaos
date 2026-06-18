import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { calculateOpportunityScores, detectBuyingStage, calcWinProbability, freshnessState } from '../lib/signalEngine.js'
import type { RawSignal } from '../lib/signalEngine.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { ingestSignal } from '../lib/signalIngest.js'
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
  await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  if (prospect.workspaceId !== workspaceId) {
    throw new ApiError(403, 'Prospect does not belong to this workspace')
  }

  const resolvedSource = source ?? 'manual'
  const resolvedDetectedAt = detectedAt ? new Date(detectedAt) : new Date()

  // Optionally record provenance. When an `evidence` object is supplied, the
  // ingest service creates an EvidenceSource and links the signal to it.
  let evidenceInput
  const evidence = req.body?.evidence
  if (evidence && typeof evidence === 'object') {
    const provider = typeof evidence.provider === 'string' ? evidence.provider.trim() : ''
    const sourceType = typeof evidence.sourceType === 'string' ? evidence.sourceType.trim() : ''
    if (!provider || !sourceType) throw new ApiError(400, 'evidence requires provider and sourceType')
    evidenceInput = {
      provider,
      sourceType,
      sourceUrl: typeof evidence.sourceUrl === 'string' ? evidence.sourceUrl : sourceUrl ?? null,
      observedAt: evidence.observedAt ? new Date(evidence.observedAt) : resolvedDetectedAt,
      expiresAt: evidence.expiresAt ? new Date(evidence.expiresAt) : null,
      confidence: Number(evidence.confidence),
      rawText: typeof evidence.rawText === 'string' ? evidence.rawText.slice(0, 5000) : null,
    }
  }

  const signal = await ingestSignal({
    workspaceId,
    prospectId,
    type,
    strength: Number(strength),
    source: resolvedSource,
    title: title ?? null,
    description: description ?? null,
    sourceUrl: sourceUrl ?? null,
    sourceReliability: sourceReliability !== undefined ? Number(sourceReliability) : undefined,
    industryRelevance: industryRelevance !== undefined ? Number(industryRelevance) : undefined,
    detectedAt: resolvedDetectedAt,
    evidence: evidenceInput,
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
  await assertMinimumWorkspaceRole(user.id, signal.workspaceId, 'admin')

  await prisma.signal.delete({ where: { id: signalId } })
  res.json({ ok: true })
}))
