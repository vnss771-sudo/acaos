import { Router } from 'express'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { aiRateLimit } from '../middleware/rateLimit.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { checkAndIncrementAiUsage } from '../lib/limits.js'
import { generateLeadResearch, generateOutreach, analyzeReply, type IcpContext } from '../services/openai.js'
import { prisma } from '../lib/prisma.js'

const MAX_NAME = 200
const MAX_NOTES = 2_000
const MAX_REPLY = 10_000
const MAX_SUMMARY = 4_000

// Trim an optional string field and cap its length so prompt-contributing inputs
// can't bloat the AI request (provider cost / abuse) within the 1MB JSON limit.
function boundedField(value: unknown, max: number, label: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ApiError(400, `${label} must be at most ${max} characters`)
  return trimmed || undefined
}

export const aiRouter = Router()
aiRouter.use(requireAuth)
aiRouter.use(requireVerifiedEmail)
aiRouter.use(aiRateLimit)

aiRouter.post(
  '/research',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId.trim() : ''
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    await checkAndIncrementAiUsage(workspaceId, 'AI_RESEARCH')

    let icp: IcpContext | undefined
    const icpRow = await prisma.workspaceICP.findUnique({
      where: { workspaceId },
      select: { targetIndustries: true, businessType: true, outreachTone: true }
    })
    if (icpRow) icp = { targetIndustries: icpRow.targetIndustries, businessType: icpRow.businessType ?? undefined, outreachTone: icpRow.outreachTone ?? undefined }

    const businessName = String(req.body?.businessName || '').trim()
    if (!businessName) throw new ApiError(400, 'businessName is required')
    if (businessName.length > MAX_NAME) throw new ApiError(400, `businessName must be at most ${MAX_NAME} characters`)

    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : undefined
    if (notes && notes.length > MAX_NOTES) throw new ApiError(400, `notes must be at most ${MAX_NOTES} characters`)

    const data = await generateLeadResearch({
      businessName,
      website: typeof req.body?.website === 'string' ? req.body.website.trim() : undefined,
      category: typeof req.body?.category === 'string' ? req.body.category.trim() : undefined,
      city: typeof req.body?.city === 'string' ? req.body.city.trim() : undefined,
      notes,
      icp
    })

    res.json({ result: data })
  })
)

aiRouter.post(
  '/outreach',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId.trim() : ''
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    await checkAndIncrementAiUsage(workspaceId, 'AI_OUTREACH')

    let icp: IcpContext | undefined
    const icpRow = await prisma.workspaceICP.findUnique({
      where: { workspaceId },
      select: { targetIndustries: true, businessType: true, outreachTone: true }
    })
    if (icpRow) icp = { targetIndustries: icpRow.targetIndustries, businessType: icpRow.businessType ?? undefined, outreachTone: icpRow.outreachTone ?? undefined }

    const businessName = String(req.body?.businessName || '').trim()
    if (!businessName) throw new ApiError(400, 'businessName is required')
    if (businessName.length > MAX_NAME) throw new ApiError(400, `businessName must be at most ${MAX_NAME} characters`)

    const data = await generateOutreach({
      businessName,
      category: boundedField(req.body?.category, MAX_NAME, 'category'),
      city: boundedField(req.body?.city, MAX_NAME, 'city'),
      contactName: boundedField(req.body?.contactName, MAX_NAME, 'contactName'),
      aiSummary: boundedField(req.body?.aiSummary, MAX_SUMMARY, 'aiSummary'),
      outreachAngle: boundedField(req.body?.outreachAngle, MAX_NOTES, 'outreachAngle'),
      notes: boundedField(req.body?.notes, MAX_NOTES, 'notes'),
      icp
    })

    res.json({ result: data })
  })
)

aiRouter.post(
  '/reply-analysis',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId.trim() : ''
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    await checkAndIncrementAiUsage(workspaceId, 'AI_REPLY')

    const replyBody = String(req.body?.replyBody || '').trim()
    if (!replyBody) throw new ApiError(400, 'replyBody is required')
    if (replyBody.length > MAX_REPLY) throw new ApiError(400, `replyBody must be at most ${MAX_REPLY} characters`)

    const data = await analyzeReply(replyBody)
    res.json({ result: data })
  })
)
