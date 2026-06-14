import { Router } from 'express'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { hashApiKey } from '../lib/apiKeys.js'
import type { AuthedRequest } from '../types/auth.js'

export const outcomesRouter = Router()

// ---------------------------------------------------------------------------
// Default ScorerV2 weights — matches scorerv2.ts initial state
// ---------------------------------------------------------------------------
const DEFAULT_WEIGHTS = {
  industry: 0.20,
  size: 0.18,
  hiring: 0.15,
  tech: 0.12,
  growth: 0.12,
  contact: 0.08,
  messageRelevance: 0.08,
  channelFit: 0.05,
  timingFit: 0.02,
  dataFreshness: 0.00
}

const DEFAULT_METRICS = {
  totalScored: 0,
  totalReplied: 0,
  replyRate: 0,
  avgScoreOfReplied: 0,
  avgScoreOfNotReplied: 0,
  correlationScore: 0
}

// ---------------------------------------------------------------------------
// Pure weight-update logic — ported from ScorerV2.updateWeights()
// ---------------------------------------------------------------------------
type Weights = typeof DEFAULT_WEIGHTS
type Metrics = typeof DEFAULT_METRICS
type Outcome = { score: number; replied: boolean; messageRelevance: number; channelUsed: string }

function calculateCorrelation(outcomes: Outcome[]): number {
  const replied = outcomes.filter(o => o.replied)
  const notReplied = outcomes.filter(o => !o.replied)
  if (replied.length === 0 || notReplied.length === 0) return 0

  const meanScore = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length
  const meanReply = replied.length / outcomes.length

  let numerator = 0, denomScore = 0, denomReply = 0
  for (const o of outcomes) {
    const sd = o.score - meanScore
    const rd = (o.replied ? 1 : 0) - meanReply
    numerator += sd * rd
    denomScore += sd * sd
    denomReply += rd * rd
  }
  if (denomScore === 0 || denomReply === 0) return 0
  return numerator / Math.sqrt(denomScore * denomReply)
}

function recomputeWeights(outcomes: Outcome[], current: Weights): { weights: Weights; metrics: Metrics } {
  const replied = outcomes.filter(o => o.replied)
  const notReplied = outcomes.filter(o => !o.replied)

  const avgReplied = replied.length > 0
    ? replied.reduce((s, o) => s + o.score, 0) / replied.length : 0
  const avgNotReplied = notReplied.length > 0
    ? notReplied.reduce((s, o) => s + o.score, 0) / notReplied.length : 0

  const correlation = calculateCorrelation(outcomes)
  const replyRate = outcomes.length > 0 ? replied.length / outcomes.length : 0

  const w = { ...current }
  const lr = 0.1

  // Weak correlation → shift weight from ICP to message/channel fit
  if (correlation < 0.3) {
    w.messageRelevance += lr * 0.02
    w.channelFit += lr * 0.02
    w.industry -= lr * 0.01
  }

  // Message relevance impact
  const msgImpact = replied.length > 0
    ? replied.reduce((s, o) => s + o.messageRelevance, 0) / replied.length : 0
  if (msgImpact > 0.7) w.messageRelevance += lr * 0.01

  // Channel impact — if LinkedIn replies outpace email, boost channelFit
  const emailReplies = replied.filter(o => o.channelUsed === 'EMAIL').length
  const linkedinReplies = replied.filter(o => o.channelUsed === 'LINKEDIN').length
  if (linkedinReplies > emailReplies * 1.5) w.channelFit += lr * 0.01

  // Clamp all weights to ≥ 0, then normalize to sum = 1
  const weightKeys = Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[]
  for (const k of weightKeys) {
    w[k] = Math.max(0, w[k])
  }
  const total = weightKeys.reduce((s, k) => s + w[k], 0)
  if (total > 0) {
    for (const k of weightKeys) {
      w[k] = w[k] / total
    }
  }

  return {
    weights: w,
    metrics: {
      totalScored: outcomes.length,
      totalReplied: replied.length,
      replyRate,
      avgScoreOfReplied: avgReplied,
      avgScoreOfNotReplied: avgNotReplied,
      correlationScore: correlation
    }
  }
}

// ---------------------------------------------------------------------------
// Upsert-or-get the scoring model for a workspace
// ---------------------------------------------------------------------------
async function getOrCreateModel(workspaceId: string) {
  return prisma.scoringModel.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      weights: DEFAULT_WEIGHTS,
      performanceMetrics: DEFAULT_METRICS
    },
    update: {}
  })
}

// ---------------------------------------------------------------------------
// Middleware: accept either ingest API key (FieldOps) or JWT (dashboard)
// Attaches workspaceId to req as req.resolvedWorkspaceId
// ---------------------------------------------------------------------------
async function requireIngestKeyOrAuth(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
) {
  // Try API key first (FieldOps machine-to-machine)
  const apiKey = req.headers['x-api-key']
  if (apiKey && typeof apiKey === 'string') {
    const workspace = await prisma.workspace.findUnique({ where: { ingestApiKey: hashApiKey(apiKey) } })
    if (!workspace) { res.status(401).json({ error: 'Invalid API key' }); return }
    ;(req as any).resolvedWorkspaceId = workspace.id
    ;(req as any).resolvedViaApiKey = true
    next()
    return
  }

  // Fall back to JWT auth
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return }
  const { verifyJwt } = await import('../lib/jwt.js')
  let payload: { userId: string }
  try { payload = verifyJwt(auth.slice(7)) } catch { res.status(401).json({ error: 'Unauthorized' }); return }
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true, email: true, name: true } })
  if (!user) { res.status(401).json({ error: 'User not found' }); return }
  ;(req as any).user = user
  next()
}

// ---------------------------------------------------------------------------
// POST /api/outcomes
// Record a reply outcome from FieldOps and update weights every 7 records
// ---------------------------------------------------------------------------
outcomesRouter.post(
  '/',
  requireIngestKeyOrAuth,
  asyncHandler(async (req, res) => {
    const viaApiKey: boolean = (req as any).resolvedViaApiKey ?? false
    let workspaceId: string

    if (viaApiKey) {
      workspaceId = (req as any).resolvedWorkspaceId
    } else {
      // JWT path — workspaceId must be in body
      workspaceId = String(req.body?.workspaceId || '').trim()
      if (!workspaceId) throw new ApiError(400, 'workspaceId required')
      const user = (req as AuthedRequest).user
      const member = await userBelongsToWorkspace(user.id, workspaceId)
      if (!member) throw new ApiError(403, 'Access denied')
    }

    const prospectId = String(req.body?.prospectId || '').trim()
    if (!prospectId) throw new ApiError(400, 'prospectId required')

    const score = Number(req.body?.score)
    if (isNaN(score) || score < 0 || score > 100) throw new ApiError(400, 'score must be 0–100')

    const replied = Boolean(req.body?.replied)
    const replyIntent = typeof req.body?.replyIntent === 'string' ? req.body.replyIntent : null
    const messageRelevance = Math.min(1, Math.max(0, Number(req.body?.messageRelevance ?? 0.5)))
    const channelUsed = req.body?.channelUsed === 'LINKEDIN' ? 'LINKEDIN' : 'EMAIL'
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() || null : null

    // The referenced records must belong to the resolved workspace. Without this
    // a valid API key could submit outcomes pointing at arbitrary prospect/lead
    // ids in other workspaces, poisoning their scoring data.
    const prospect = await prisma.prospect.findFirst({ where: { id: prospectId, workspaceId }, select: { id: true } })
    if (!prospect) throw new ApiError(400, 'prospectId not found in this workspace')
    if (leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId }, select: { id: true } })
      if (!lead) throw new ApiError(400, 'leadId not found in this workspace')
    }

    const model = await getOrCreateModel(workspaceId)

    await prisma.scoringOutcome.create({
      data: {
        workspaceId,
        leadId,
        prospectId,
        score,
        replied,
        replyIntent,
        messageRelevance,
        channelUsed,
        scoringModelId: model.id
      }
    })

    // Count total outcomes and recalculate weights every 7
    const totalOutcomes = await prisma.scoringOutcome.count({ where: { scoringModelId: model.id } })
    let weightsUpdated = false

    if (totalOutcomes >= 7 && totalOutcomes % 7 === 0) {
      const all = await prisma.scoringOutcome.findMany({
        where: { scoringModelId: model.id },
        select: { score: true, replied: true, messageRelevance: true, channelUsed: true }
      })

      const { weights, metrics } = recomputeWeights(all, model.weights as Weights)

      await prisma.scoringModel.update({
        where: { id: model.id },
        data: {
          weights,
          performanceMetrics: metrics,
          updateCount: { increment: 1 },
          lastWeightUpdate: new Date()
        }
      })
      weightsUpdated = true
    }

    res.status(201).json({ recorded: true, weightsUpdated, totalOutcomes })
  })
)

// ---------------------------------------------------------------------------
// GET /api/outcomes/model  — FieldOps reads weights before scoring a batch
// ---------------------------------------------------------------------------
outcomesRouter.get(
  '/model',
  requireIngestKeyOrAuth,
  asyncHandler(async (req, res) => {
    const viaApiKey: boolean = (req as any).resolvedViaApiKey ?? false
    let workspaceId: string

    if (viaApiKey) {
      workspaceId = (req as any).resolvedWorkspaceId
    } else {
      workspaceId = String(req.query.workspaceId || '').trim()
      if (!workspaceId) throw new ApiError(400, 'workspaceId required')
      const user = (req as AuthedRequest).user
      const member = await userBelongsToWorkspace(user.id, workspaceId)
      if (!member) throw new ApiError(403, 'Access denied')
    }

    const model = await getOrCreateModel(workspaceId)
    const totalOutcomes = await prisma.scoringOutcome.count({ where: { scoringModelId: model.id } })

    res.json({
      workspaceId,
      weights: model.weights,
      performanceMetrics: model.performanceMetrics,
      updateCount: model.updateCount,
      lastWeightUpdate: model.lastWeightUpdate,
      totalOutcomes,
      updatedAt: model.updatedAt
    })
  })
)

// ---------------------------------------------------------------------------
// POST /api/outcomes/model/reset  — JWT + owner only — fresh start
// ---------------------------------------------------------------------------
outcomesRouter.post(
  '/model/reset',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: 'owner' }
    })
    if (!membership) throw new ApiError(403, 'Only workspace owners can reset the scoring model')

    await prisma.scoringModel.upsert({
      where: { workspaceId },
      create: { workspaceId, weights: DEFAULT_WEIGHTS, performanceMetrics: DEFAULT_METRICS },
      update: {
        weights: DEFAULT_WEIGHTS,
        performanceMetrics: DEFAULT_METRICS,
        updateCount: 0,
        lastWeightUpdate: null
      }
    })

    // Delete all outcomes so the model starts fresh
    await prisma.scoringOutcome.deleteMany({
      where: { workspaceId }
    })

    res.json({ reset: true, weights: DEFAULT_WEIGHTS })
  })
)
