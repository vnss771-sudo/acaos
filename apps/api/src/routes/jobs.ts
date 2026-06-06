import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { aiRateLimit } from '../middleware/rateLimit.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { checkAndIncrementAiUsage } from '../lib/limits.js'
import {
  enqueueResearchLead,
  enqueueGenerateOutreach,
  enqueueAnalyzeReply,
  getJobById
} from '../lib/queues.js'
import type { AuthedRequest } from '../types/auth.js'

export const jobsRouter = Router()

const QUEUE_NAMES = ['research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox']
const MAX_REPLY_BODY = 10_000

// SSE endpoint registered BEFORE requireAuth so it can use its own token-based auth
// (EventSource API cannot set custom headers, so auth is passed via ?token=)
jobsRouter.get(
  '/events/:queue/:jobId',
  asyncHandler(async (req, res) => {
    const { queue, jobId } = req.params
    if (!QUEUE_NAMES.includes(queue)) throw new ApiError(400, `Unknown queue: ${queue}`)

    const token = String(req.query.token || '').trim()
    if (!token) throw new ApiError(401, 'Authentication required')

    let userId: string
    try {
      const { verifyJwt } = await import('../lib/jwt.js')
      const payload = verifyJwt(token) as { userId: string }
      userId = payload.userId
    } catch {
      throw new ApiError(401, 'Invalid or expired token')
    }

    const job = await getJobById(queue, jobId)
    if (!job) throw new ApiError(404, 'Job not found')

    const jobUserId = (job.data as Record<string, unknown>).userId
    if (jobUserId && jobUserId !== userId) throw new ApiError(403, 'Access denied')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const TICK_MS = 800
    const MAX_TICKS = 450 // 6 minutes

    let ticks = 0
    let timer: ReturnType<typeof setTimeout>

    function send(event: string, data: unknown) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    async function poll() {
      try {
        const j = await getJobById(queue, jobId)
        if (!j) { send('error', { message: 'Job disappeared' }); res.end(); return }

        const state = await j.getState()
        send('progress', { state, progress: j.progress, jobId })

        if (state === 'completed') {
          send('done', { state: 'completed', result: j.returnvalue, jobId })
          res.end()
          return
        }
        if (state === 'failed') {
          send('done', { state: 'failed', error: j.failedReason, jobId })
          res.end()
          return
        }

        ticks++
        if (ticks >= MAX_TICKS) {
          send('timeout', { message: 'Monitoring timed out — job still running', jobId })
          res.end()
          return
        }

        timer = setTimeout(poll, TICK_MS)
      } catch {
        res.end()
      }
    }

    timer = setTimeout(poll, 0)
    req.on('close', () => clearTimeout(timer))
  })
)

// All remaining routes require JWT auth via Authorization header
jobsRouter.use(requireAuth)

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

    await checkAndIncrementAiUsage(lead.workspaceId, 'AI_RESEARCH')

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

    await checkAndIncrementAiUsage(lead.workspaceId, 'AI_OUTREACH')

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

    let workspaceId: string | null = null
    if (leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId } })
      if (!lead) throw new ApiError(404, 'Lead not found')
      const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
      if (!member) throw new ApiError(403, 'Access denied')
      workspaceId = lead.workspaceId
    }

    if (workspaceId) await checkAndIncrementAiUsage(workspaceId, 'AI_REPLY')

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

    // Check usage before bulk queue (counts all at once)
    for (let i = 0; i < leads.length; i++) {
      await checkAndIncrementAiUsage(workspaceId, 'AI_RESEARCH')
    }

    const jobs = await Promise.all(leads.map(l => enqueueResearchLead(l.id, user.id)))
    res.status(202).json({ queued: jobs.length, jobs: jobs.map(j => ({ jobId: j.id, leadId: j.name })) })
  })
)

// Poll job status
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

