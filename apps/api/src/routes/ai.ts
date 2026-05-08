import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { aiRateLimit } from '../middleware/rateLimit.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../services/openai.js'

const MAX_NAME = 200
const MAX_NOTES = 2_000
const MAX_REPLY = 10_000

export const aiRouter = Router()
aiRouter.use(requireAuth)
aiRouter.use(aiRateLimit)

aiRouter.post(
  '/research',
  asyncHandler(async (req, res) => {
    const businessName = String(req.body?.businessName || '').trim()
    if (!businessName) throw new ApiError(400, 'businessName is required')
    if (businessName.length > MAX_NAME) throw new ApiError(400, `businessName must be at most ${MAX_NAME} characters`)

    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : undefined
    if (notes && notes.length > MAX_NOTES) throw new ApiError(400, `notes must be at most ${MAX_NOTES} characters`)

    const data = await generateLeadResearch({
      businessName,
      website: typeof req.body?.website === 'string' ? req.body.website.trim() : undefined,
      notes
    })

    res.json({ result: data })
  })
)

aiRouter.post(
  '/outreach',
  asyncHandler(async (req, res) => {
    const businessName = String(req.body?.businessName || '').trim()
    if (!businessName) {
      throw new ApiError(400, 'businessName is required')
    }

    const data = await generateOutreach({
      businessName,
      category: typeof req.body?.category === 'string' ? req.body.category.trim() : undefined,
      aiSummary: typeof req.body?.aiSummary === 'string' ? req.body.aiSummary.trim() : undefined,
      outreachAngle:
        typeof req.body?.outreachAngle === 'string' ? req.body.outreachAngle.trim() : undefined
    })

    res.json({ result: data })
  })
)

aiRouter.post(
  '/reply-analysis',
  asyncHandler(async (req, res) => {
    const replyBody = String(req.body?.replyBody || '').trim()
    if (!replyBody) throw new ApiError(400, 'replyBody is required')
    if (replyBody.length > MAX_REPLY) throw new ApiError(400, `replyBody must be at most ${MAX_REPLY} characters`)

    const data = await analyzeReply(replyBody)
    res.json({ result: data })
  })
)
