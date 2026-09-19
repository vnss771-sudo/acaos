import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { parseBody, parseQuery, workspaceIdField } from '../lib/validate.js'
import { explainLeadScore, getWorkspaceWeights } from '@acaos/backend-core/lib/scoring.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'

// Lead scoring as a service — premium feature for ICP matching + lead qualification.
// Provides detailed score explanations, signal breakdowns, and tier assignments.
// Used to power upsell of "Premium Lead Scoring" which unlocks:
// - Detailed scoring explanations (why a lead scored what)
// - Predictive reply likelihood (learning loop driven)
// - Custom weight tuning per workspace

export const leadScoringRouter = Router()
leadScoringRouter.use(requireAuth)
leadScoringRouter.use(requireVerifiedForMutation)

const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })

const scoreLeadSchema = z.object({
  workspaceId: workspaceIdField,
  businessName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().optional().nullable(),
  email: z.string().trim().optional().nullable(),
  website: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  aiSummary: z.string().trim().optional().nullable(),
  outreachAngle: z.string().trim().optional().nullable(),
})

const batchScoreLeadsSchema = z.object({
  workspaceId: workspaceIdField,
  leads: z.array(scoreLeadSchema.omit({ workspaceId: true }))
    .min(1).max(100),
})

// GET /api/lead-scoring/explain/:leadId — get the scoring explanation for an existing lead
leadScoringRouter.get(
  '/explain/:leadId',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { leadId } = req.params as { leadId: string }

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        workspaceId: true,
        businessName: true,
        contactName: true,
        email: true,
        website: true,
        category: true,
        notes: true,
        aiSummary: true,
        outreachAngle: true,
      },
    })

    if (!lead) throw new ApiError(404, 'Lead not found')

    // Verify workspace access
    if (!(await userBelongsToWorkspace(user.id, lead.workspaceId))) {
      throw new ApiError(403, 'Workspace access denied')
    }

    // Get workspace weights for scoring
    const weights = await getWorkspaceWeights(lead.workspaceId)

    // Generate explanation
    const explanation = explainLeadScore(lead, weights)

    // Audit the scoring request
    void recordAudit({
      workspaceId: lead.workspaceId,
      actorUserId: user.id,
      type: 'lead_scoring.explained',
      entityType: 'lead',
      entityId: leadId,
      metadata: { score: explanation.score, tier: explanation.tier },
    })

    res.json({ lead: { id: lead.id }, explanation })
  })
)

// POST /api/lead-scoring/score — single lead scoring with explanation
leadScoringRouter.post(
  '/score',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const body = parseBody(scoreLeadSchema, req)

    // Verify workspace access
    if (!(await userBelongsToWorkspace(user.id, body.workspaceId))) {
      throw new ApiError(403, 'Workspace access denied')
    }

    // Get workspace weights
    const weights = await getWorkspaceWeights(body.workspaceId)

    // Score the lead
    const explanation = explainLeadScore(body, weights)

    // Audit
    void recordAudit({
      workspaceId: body.workspaceId,
      actorUserId: user.id,
      type: 'lead_scoring.single_score',
      entityType: 'workspace',
      entityId: body.workspaceId,
      metadata: { score: explanation.score, tier: explanation.tier },
    })

    res.json({ explanation })
  })
)

// POST /api/lead-scoring/batch — batch score up to 100 leads with explanations
leadScoringRouter.post(
  '/batch',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const body = parseBody(batchScoreLeadsSchema, req)

    // Verify workspace access
    if (!(await userBelongsToWorkspace(user.id, body.workspaceId))) {
      throw new ApiError(403, 'Workspace access denied')
    }

    // Get workspace weights
    const weights = await getWorkspaceWeights(body.workspaceId)

    // Score all leads
    const results = body.leads.map((lead, idx) => ({
      index: idx,
      businessName: lead.businessName,
      explanation: explainLeadScore(lead, weights),
    }))

    // Audit batch operation
    void recordAudit({
      workspaceId: body.workspaceId,
      actorUserId: user.id,
      type: 'lead_scoring.batch_score',
      entityType: 'workspace',
      entityId: body.workspaceId,
      metadata: { count: body.leads.length, avgScore: Math.round(results.reduce((s, r) => s + r.explanation.score, 0) / results.length) },
    })

    res.json({ results })
  })
)

// GET /api/lead-scoring/stats — workspace scoring performance metrics (learning loop)
// Shows how well the scoring model is performing against actual reply outcomes
leadScoringRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)

    // Verify workspace access
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
      throw new ApiError(403, 'Workspace access denied')
    }

    // Get the scoring model with performance metrics
    const model = await prisma.scoringModel.findUnique({
      where: { workspaceId },
      select: {
        weights: true,
        performanceMetrics: true,
        updateCount: true,
        lastWeightUpdate: true,
      },
    })

    if (!model) {
      return res.json({
        workspaceId,
        hasModel: false,
        message: 'Scoring model not yet initialized',
      })
    }

    // Get lead and reply counts for context
    const [totalLeads, repliedLeads] = await Promise.all([
      prisma.lead.count({ where: { workspaceId } }),
      prisma.lead.count({ where: { workspaceId, stage: 'REPLIED' } }),
    ])

    res.json({
      workspaceId,
      hasModel: true,
      metrics: model.performanceMetrics,
      updateCount: model.updateCount,
      lastWeightUpdate: model.lastWeightUpdate,
      context: {
        totalLeads,
        repliedLeads,
        replyRate: totalLeads > 0 ? (repliedLeads / totalLeads * 100).toFixed(1) : 0,
      },
    })
  })
)

// GET /api/lead-scoring/weights — get current workspace scoring weights
leadScoringRouter.get(
  '/weights',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)

    // Verify workspace access
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) {
      throw new ApiError(403, 'Workspace access denied')
    }

    const weights = await getWorkspaceWeights(workspaceId)

    res.json({ workspaceId, weights })
  })
)
