import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, ApiError } from '../lib/http.js'
import { parseBody, parseQuery, nonEmptyString } from '../lib/validate.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { hashApiKey } from '../lib/apiKeys.js'
import { apiKeyRateLimit } from '../middleware/rateLimit.js'
import { invalidateWorkspaceStats } from '../lib/statsCache.js'

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
    req.resolvedWorkspaceId = workspace.id
    req.resolvedViaApiKey = true
    next()
    return
  }

  // Fall back to JWT auth
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return }
  const { verifyJwt } = await import('../lib/jwt.js')
  let payload: { userId: string }
  try { payload = verifyJwt(auth.slice(7)) } catch { res.status(401).json({ error: 'Unauthorized' }); return }
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true, email: true, name: true, emailVerified: true, isPlatformAdmin: true } })
  if (!user) { res.status(401).json({ error: 'User not found' }); return }
  req.user = user
  next()
}

// ---------------------------------------------------------------------------
// POST /api/outcomes
// Record a reply outcome from FieldOps and update weights every 7 records
// ---------------------------------------------------------------------------
// workspaceId is optional here: the API-key path resolves it from the key and
// omits it from the body, while the JWT path requires it (enforced below).
const recordOutcomeSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  prospectId: nonEmptyString,
  score: z.coerce.number().min(0, 'score must be 0–100').max(100, 'score must be 0–100'),
  replied: z.coerce.boolean().optional(),
  replyIntent: z.string().optional(),
  messageRelevance: z.coerce.number().optional(),
  channelUsed: z.string().optional(),
  leadId: z.string().optional(),
})

// GET /model (JWT path) query + POST /model/reset body. Both mirror the prior
// `String(... || '').trim()` + `if (!workspaceId) 400 'workspaceId required'`.
const modelQuerySchema = z.object({
  workspaceId: z.string().trim().min(1, 'workspaceId required'),
})
const resetModelSchema = z.object({
  workspaceId: z.string().trim().min(1, 'workspaceId required'),
})

outcomesRouter.post(
  '/',
  apiKeyRateLimit,
  requireIngestKeyOrAuth,
  asyncHandler(async (req, res) => {
    const viaApiKey: boolean = req.resolvedViaApiKey ?? false
    const parsed = parseBody(recordOutcomeSchema, req)
    let workspaceId: string

    if (viaApiKey) {
      workspaceId = req.resolvedWorkspaceId!
    } else {
      // JWT path — workspaceId must be in body. Recording an outcome retunes the
      // shared workspace scoring model (every 7th outcome recomputes its
      // weights), so the human path requires admin, not plain membership. The
      // automated FieldOps ingest path (API key) is authorized by the key itself.
      if (!parsed.workspaceId) throw new ApiError(400, 'workspaceId required')
      workspaceId = parsed.workspaceId
      const user = req.user!
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')
    }

    const prospectId = parsed.prospectId
    const score = parsed.score
    const replied = parsed.replied ?? false
    const replyIntent = typeof parsed.replyIntent === 'string' ? parsed.replyIntent : null
    const messageRelevance = Math.min(1, Math.max(0, parsed.messageRelevance ?? 0.5))
    const channelUsed = parsed.channelUsed === 'LINKEDIN' ? 'LINKEDIN' : 'EMAIL'
    const leadId = typeof parsed.leadId === 'string' ? parsed.leadId.trim() || null : null

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
      // Retuned weights change the scoringModel block in the dashboard summary.
      invalidateWorkspaceStats(workspaceId)
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
    const viaApiKey: boolean = req.resolvedViaApiKey ?? false
    let workspaceId: string

    if (viaApiKey) {
      workspaceId = req.resolvedWorkspaceId!
    } else {
      workspaceId = parseQuery(modelQuerySchema, req).workspaceId
      const user = req.user!
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
    const user = req.user!
    const { workspaceId } = parseBody(resetModelSchema, req)

    await assertWorkspacePermission(user.id, workspaceId, 'model:reset')

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
