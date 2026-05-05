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

// Enqueue: research a lead asynchronously
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

    const job = await enqueueResearchLead(leadId)
    res.status(202).json({ jobId: job.id, queue: 'research-lead', status: 'queued' })
  })
)

// Enqueue: generate outreach for a lead asynchronously
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

    const job = await enqueueGenerateOutreach(leadId)
    res.status(202).json({ jobId: job.id, queue: 'generate-outreach', status: 'queued' })
  })
)

// Enqueue: analyze an inbound reply
jobsRouter.post(
  '/analyze-reply',
  aiRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const replyBody = String(req.body?.replyBody || '').trim()
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() : undefined

    if (!replyBody) throw new ApiError(400, 'replyBody required')

    if (leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId } })
      if (!lead) throw new ApiError(404, 'Lead not found')
      const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
      if (!member) throw new ApiError(403, 'Access denied')
    }

    const job = await enqueueAnalyzeReply(replyBody, leadId)
    res.status(202).json({ jobId: job.id, queue: 'analyze-reply', status: 'queued' })
  })
)

// Bulk enqueue: research all NEW leads in a workspace
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

    const jobs = await Promise.all(leads.map(l => enqueueResearchLead(l.id)))
    res.status(202).json({ queued: jobs.length, jobs: jobs.map(j => ({ jobId: j.id, leadId: j.name })) })
  })
)

// Poll job status
jobsRouter.get(
  '/:queue/:jobId',
  asyncHandler(async (req, res) => {
    const { queue, jobId } = req.params
    if (!QUEUE_NAMES.includes(queue)) throw new ApiError(400, `Unknown queue: ${queue}`)

    const job = await getJobById(queue, jobId)
    if (!job) throw new ApiError(404, 'Job not found')

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
