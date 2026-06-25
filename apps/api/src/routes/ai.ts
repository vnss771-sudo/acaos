import { Router } from 'express'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { requireFeature } from '../middleware/featureGate.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { aiRateLimit } from '../middleware/rateLimit.js'
import { enforceWorkspaceAiRate } from '../lib/workspaceRateLimit.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { checkAndIncrementAiUsage } from '../lib/limits.js'
import { generateLeadResearch, generateOutreach, analyzeReply, type IcpContext } from '../services/openai.js'
import { explainLeadScore, getWorkspaceWeights } from '../lib/scoring.js'
import { prisma } from '../lib/prisma.js'
import { validate, workspaceIdField } from '../lib/validate.js'
import { z } from 'zod'

const MAX_NAME = 200
const MAX_NOTES = 2_000
const MAX_REPLY = 10_000
const MAX_SUMMARY = 4_000

// A trimmed, optional, length-bounded prompt-contributing field. Replaces the old
// boundedField() helper: trims, enforces the same max length (now a schema-level
// 400), and collapses an empty result to undefined so it isn't sent to the model.
const boundedOptional = (max: number) =>
  z.string().trim().max(max).optional().transform(v => (v ? v : undefined))

// Research/outreach require a non-empty businessName (the old `String(...).trim()`
// + `if (!businessName) 400` pair), capped at MAX_NAME.
const businessNameField = z.string().trim().min(1, 'businessName is required').max(MAX_NAME)

const researchSchema = z.object({
  workspaceId: workspaceIdField,
  businessName: businessNameField,
  // website/category/city had no length cap in the original handler — keep them
  // uncapped (just trimmed) so behaviour is unchanged.
  website: z.string().trim().optional().transform(v => (v ? v : undefined)),
  category: z.string().trim().optional().transform(v => (v ? v : undefined)),
  city: z.string().trim().optional().transform(v => (v ? v : undefined)),
  notes: z.string().trim().max(MAX_NOTES).optional().transform(v => (v ? v : undefined)),
})

const outreachSchema = z.object({
  workspaceId: workspaceIdField,
  businessName: businessNameField,
  category: boundedOptional(MAX_NAME),
  city: boundedOptional(MAX_NAME),
  contactName: boundedOptional(MAX_NAME),
  aiSummary: boundedOptional(MAX_SUMMARY),
  outreachAngle: boundedOptional(MAX_NOTES),
  notes: boundedOptional(MAX_NOTES),
})

const replyAnalysisSchema = z.object({
  workspaceId: workspaceIdField,
  replyBody: z.string().trim().min(1, 'replyBody is required').max(MAX_REPLY),
})

export const aiRouter = Router()
aiRouter.use(requireAuth)
aiRouter.use(requireVerifiedEmail)
aiRouter.use(requireFeature('ai'))
aiRouter.use(aiRateLimit)

aiRouter.post(
  '/research',
  validate(researchSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, businessName, website, category, city, notes } = req.body as z.infer<typeof researchSchema>

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    await enforceWorkspaceAiRate(workspaceId)
    await checkAndIncrementAiUsage(workspaceId, 'AI_RESEARCH')

    let icp: IcpContext | undefined
    const icpRow = await prisma.workspaceICP.findUnique({
      where: { workspaceId },
      select: { targetIndustries: true, businessType: true, outreachTone: true }
    })
    if (icpRow) icp = { targetIndustries: icpRow.targetIndustries, businessType: icpRow.businessType ?? undefined, outreachTone: icpRow.outreachTone ?? undefined }

    const data = await generateLeadResearch({
      businessName,
      website,
      category,
      city,
      notes,
      icp
    })

    // Deterministic, model-independent rationale for the ICP score — the "why",
    // not just a number. Computed from the request inputs so it is auditable and
    // does not depend on (or trust) the model's self-reported icpScore.
    const weights = await getWorkspaceWeights(workspaceId)
    const { score, tier, topReasons, signals } = explainLeadScore(
      { businessName, category, website, notes },
      weights,
    )

    res.json({ result: data, scoreRationale: { score, tier, topReasons, signals } })
  })
)

aiRouter.post(
  '/outreach',
  validate(outreachSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, businessName, category, city, contactName, aiSummary, outreachAngle, notes } =
      req.body as z.infer<typeof outreachSchema>

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    await enforceWorkspaceAiRate(workspaceId)
    await checkAndIncrementAiUsage(workspaceId, 'AI_OUTREACH')

    let icp: IcpContext | undefined
    const icpRow = await prisma.workspaceICP.findUnique({
      where: { workspaceId },
      select: { targetIndustries: true, businessType: true, outreachTone: true }
    })
    if (icpRow) icp = { targetIndustries: icpRow.targetIndustries, businessType: icpRow.businessType ?? undefined, outreachTone: icpRow.outreachTone ?? undefined }

    const data = await generateOutreach({
      businessName,
      category,
      city,
      contactName,
      aiSummary,
      outreachAngle,
      notes,
      icp
    })

    res.json({ result: data })
  })
)

aiRouter.post(
  '/reply-analysis',
  validate(replyAnalysisSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, replyBody } = req.body as z.infer<typeof replyAnalysisSchema>

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    await enforceWorkspaceAiRate(workspaceId)
    await checkAndIncrementAiUsage(workspaceId, 'AI_REPLY')

    const data = await analyzeReply(replyBody)
    res.json({ result: data })
  })
)
