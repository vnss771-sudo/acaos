import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { aiRateLimit } from '../middleware/rateLimit.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import {
  enqueueResearchLead,
  enqueueGenerateOutreach,
  enqueueAnalyzeReply,
  getJobById
} from '../lib/queues.js'
import type { AuthedRequest } from '../types/auth.js'

export const jobsRouter = Router()
jobsRouter.use(requireAuth)

const QUEUE_NAMES = ['research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox']
const MAX_REPLY_BODY = 10_000

jobsRouter.post(
  '/research',
  aiRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const leadId = String(req.body?.leadId || '').trim()
    if (!leadId) throw new ApiError(400, 'leadId required')

    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const job = await enqueueResearchLead(leadId, user.id)
    res.status(202).json({ jobId: job.id, queue: 'research-lead', status: 'queued' })
  })
)

jobsRouter.post(
  '/outreach',
  aiRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const leadId = String(req.body?.leadId || '').trim()
    if (!leadId) throw new ApiError(400, 'leadId required')

    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new ApiError(404, 'Lead not found')

    const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const job = await enqueueGenerateOutreach(leadId, user.id)
    res.status(202).json({ jobId: job.id, queue: 'generate-outreach', status: 'queued' })
  })
)

jobsRouter.post(
  '/analyze-reply',
  aiRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const replyBody = String(req.body?.replyBody || '').trim()
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() : undefined

    if (!replyBody) throw new ApiError(400, 'replyBody required')
    if (replyBody.length > MAX_REPLY_BODY) throw new ApiError(400, `replyBody must be at most ${MAX_REPLY_BODY} characters`)

    if (leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId } })
      if (!lead) throw new ApiError(404, 'Lead not found')
      const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
      if (!member) throw new ApiError(403, 'Access denied')
    }

    const job = await enqueueAnalyzeReply(replyBody, leadId, user.id)
    res.status(202).json({ jobId: job.id, queue: 'analyze-reply', status: 'queued' })
  })
)

jobsRouter.post(
  '/research-bulk',
  aiRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const leads = await prisma.lead.findMany({
      where: { workspaceId, stage: 'NEW' },
      select: { id: true },
      take: 50
    })

    const jobs = await Promise.all(leads.map(l => enqueueResearchLead(l.id, user.id)))
    res.status(202).json({ queued: jobs.length, jobs: jobs.map(j => ({ jobId: j.id, leadId: j.name })) })
  })
)

// Poll job status — only the user who enqueued the job may read its result
jobsRouter.get(
  '/:queue/:jobId',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { queue, jobId } = req.params
    if (!QUEUE_NAMES.includes(queue)) throw new ApiError(400, `Unknown queue: ${queue}`)

    const job = await getJobById(queue, jobId)
    if (!job) throw new ApiError(404, 'Job not found')

    const jobUserId = (job.data as Record<string, unknown>).userId
    if (jobUserId && jobUserId !== user.id) throw new ApiError(403, 'Access denied')

    const state = await job.getState()
    const result = state === 'completed' ? job.returnvalue : undefined
    const failedReason = state === 'failed' ? job.failedReason : undefined

    res.json({
      jobId: job.id,
      queue,
      state,
      progress: job.progress,
      result,
      failedReason,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn
    })
  })
)
