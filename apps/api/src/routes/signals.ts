import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { parseBody, parseQuery, nonEmptyString, workspaceIdField } from '../lib/validate.js'
import { prisma } from '../lib/prisma.js'
import { calculateOpportunityScores, detectBuyingStage, calcWinProbability, freshnessState } from '../lib/signalEngine.js'
import type { RawSignal, SignalType } from '../lib/signalEngine.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { ingestSignal } from '../lib/signalIngest.js'
import type { Assert, CreateSignalRequest, Extends } from '@acaos/shared'

export const signalsRouter = Router()
signalsRouter.use(requireAuth)
signalsRouter.use(requireVerifiedForMutation)

function toRawSignal(s: { type: string; strength: number; sourceReliability: number; industryRelevance: number; detectedAt: Date }): RawSignal {
  return { type: s.type as RawSignal['type'], strength: s.strength, sourceReliability: s.sourceReliability, industryRelevance: s.industryRelevance, detectedAt: s.detectedAt }
}

const listSignalsQuerySchema = z.object({
  workspaceId: workspaceIdField,
  prospectId: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
})

// GET /api/signals?workspaceId=&prospectId=&type=
signalsRouter.get('/', asyncHandler(async (req, res) => {
  const { workspaceId, prospectId, type, limit } = parseQuery(listSignalsQuerySchema, req)

  const user = req.user!
  if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
    throw new ApiError(403, 'Workspace access denied')
  }

  const where: Record<string, unknown> = { workspaceId }
  if (prospectId) where.prospectId = prospectId
  if (type) where.type = type

  const signals = await prisma.signal.findMany({
    where,
    orderBy: { detectedAt: 'desc' },
    take: Math.min(limit ?? 100, 200),
    include: { prospect: { select: { id: true, companyName: true } } }
  })

  // Attach the user-facing freshness state (decay-derived) so the UI can show
  // LIVE/RECENT/STALE/EXPIRED without recomputing decay client-side.
  const withFreshness = signals.map((s: (typeof signals)[number]) => ({
    ...s,
    freshness: freshnessState({ type: s.type, detectedAt: s.detectedAt }),
  }))

  res.json({ signals: withFreshness })
}))

// strength/reliability/relevance accept numeric strings (coerced) to match the
// previous hand-rolled Number(...) behaviour. `type` is validated as a non-empty
// string here and mapped to the signal enum downstream.
const createSignalSchema = z.object({
  workspaceId: workspaceIdField,
  prospectId: nonEmptyString,
  type: nonEmptyString,
  strength: z.coerce.number().min(0, 'strength must be 0-100').max(100, 'strength must be 0-100'),
  title: z.string().optional(),
  description: z.string().optional(),
  sourceUrl: z.string().optional(),
  source: z.string().optional(),
  sourceReliability: z.coerce.number().optional(),
  industryRelevance: z.coerce.number().optional(),
  detectedAt: z.union([z.string(), z.number()]).optional(),
  evidence: z.object({
    provider: z.string().optional(),
    sourceType: z.string().optional(),
    sourceUrl: z.string().optional(),
    observedAt: z.union([z.string(), z.number()]).optional(),
    expiresAt: z.union([z.string(), z.number()]).optional(),
    confidence: z.coerce.number().optional(),
    rawText: z.string().optional(),
  }).optional(),
})
// Compile-time drift guard: the request schema must remain assignable to the
// shared contract (detectedAt accepts string|number; the extra `evidence` object
// is permitted by Extends). Bound after widening CreateSignalRequest.detectedAt.
type _CreateSignalConforms = Assert<Extends<z.infer<typeof createSignalSchema>, CreateSignalRequest>>

// POST /api/signals — add a manual signal
signalsRouter.post('/', asyncHandler(async (req, res) => {
  const body = parseBody(createSignalSchema, req)
  const { workspaceId, prospectId, type, strength, title, description, sourceUrl,
    sourceReliability, industryRelevance } = body

  const user = req.user!
  await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  if (prospect.workspaceId !== workspaceId) {
    throw new ApiError(403, 'Prospect does not belong to this workspace')
  }

  const resolvedSource = body.source ?? 'manual'
  const resolvedDetectedAt = body.detectedAt ? new Date(body.detectedAt) : new Date()

  // Optionally record provenance. When an `evidence` object is supplied, the
  // ingest service creates an EvidenceSource and links the signal to it.
  let evidenceInput
  const evidence = body.evidence
  if (evidence) {
    const provider = evidence.provider?.trim() ?? ''
    const sourceType = evidence.sourceType?.trim() ?? ''
    if (!provider || !sourceType) throw new ApiError(400, 'evidence requires provider and sourceType')
    evidenceInput = {
      provider,
      sourceType,
      sourceUrl: evidence.sourceUrl ?? sourceUrl ?? null,
      observedAt: evidence.observedAt ? new Date(evidence.observedAt) : resolvedDetectedAt,
      expiresAt: evidence.expiresAt ? new Date(evidence.expiresAt) : null,
      confidence: evidence.confidence ?? NaN,
      rawText: typeof evidence.rawText === 'string' ? evidence.rawText.slice(0, 5000) : null,
    }
  }

  const signal = await ingestSignal({
    workspaceId,
    prospectId,
    type: type as SignalType,
    strength,
    source: resolvedSource,
    title: title ?? null,
    description: description ?? null,
    sourceUrl: sourceUrl ?? null,
    sourceReliability,
    industryRelevance,
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

  const user = req.user!
  await assertMinimumWorkspaceRole(user.id, signal.workspaceId, 'admin')

  await prisma.signal.delete({ where: { id: signalId } })
  res.json({ ok: true })
}))
