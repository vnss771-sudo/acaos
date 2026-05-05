import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../services/openai.js'

export const aiRouter = Router()
aiRouter.use(requireAuth)

aiRouter.post(
  '/research',
  asyncHandler(async (req, res) => {
    const businessName = String(req.body?.businessName || '').trim()
    if (!businessName) {
      throw new ApiError(400, 'businessName is required')
    }

    const data = await generateLeadResearch({
      businessName,
      website: typeof req.body?.website === 'string' ? req.body.website.trim() : undefined,
      notes: typeof req.body?.notes === 'string' ? req.body.notes.trim() : undefined
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
    if (!replyBody) {
      throw new ApiError(400, 'replyBody is required')
    }

    const data = await analyzeReply(replyBody)
    res.json({ result: data })
  })
)
