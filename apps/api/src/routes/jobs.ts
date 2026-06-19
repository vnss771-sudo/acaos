import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { aiRateLimit, sseTicketRateLimit } from '../middleware/rateLimit.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { checkAndIncrementAiUsage } from '../lib/limits.js'
import {
  enqueueResearchLead,
  enqueueGenerateOutreach,
  enqueueAnalyzeReply,
  getJobById
} from '../lib/queues.js'
import { issueSseTicket, consumeSseTicket } from '../lib/sseTickets.js'
import type { AuthedRequest } from '../types/auth.js'
import type { Job } from 'bullmq'

async function assertCanReadJob(userId: string, job: Job): Promise<void> {
  const data = job.data as Record<string, unknown>
  // Prefer workspace membership so any teammate can poll a workspace-scoped job,
  // regardless of who initiated it.
  if (typeof data.workspaceId === 'string') {
    const member = await userBelongsToWorkspace(userId, data.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')
    return
  }
  // Fallback for user-scoped jobs (no workspace on the payload).
  const owner = typeof data.initiatedByUserId === 'string' ? data.initiatedByUserId
    : typeof data.userId === 'string' ? data.userId : null
  if (owner) {
    if (owner !== userId) throw new ApiError(403, 'Access denied')
    return
  }
  throw new ApiError(403, 'Job is not scoped to a user or workspace')
}

export const jobsRouter = Router()

const QUEUE_NAMES = ['research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox', 'send-campaign', 'score-prospects', 'calibrate-scoring', 'generate-recommendations']
const MAX_REPLY_BODY = 10_000

// Server-Sent Events stream for real-time job progress. Registered BEFORE
// requireAuth because EventSource cannot send an Authorization header; it
// authenticates with a short-lived, single-use ticket (see /events/ticket)
// exchanged from Redis, rather than a long-lived JWT in the URL.
jobsRouter.get('/events/:queue/:jobId', asyncHandler(async (req, res) => {
  const queue = req.params.queue as string
  const jobId = req.params.jobId as string
  if (!QUEUE_NAMES.includes(queue)) throw new ApiError(400, `Unknown queue: ${queue}`)

  const userId = await consumeSseTicket(String(req.query.ticket || '').trim())
  if (!userId) throw new ApiError(401, 'Invalid or expired ticket')

  const job = await getJobById(queue, jobId)
  if (!job) throw new ApiError(404, 'Job not found')

  await assertCanReadJob(userId, job)

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
}))

// Everything below requires a normal authenticated session.
jobsRouter.use(requireAuth)

// Issue a one-time SSE ticket (authenticated via the Authorization header).
// The browser exchanges this for the EventSource URL above.
jobsRouter.post('/events/ticket', sseTicketRateLimit, asyncHandler(async (req, res) => {
  const user = (req as AuthedRequest).user
  const ticket = await issueSseTicket(user.id)
  res.json({ ticket })
}))

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

    const job = await enqueueResearchLead({ leadId, workspaceId: lead.workspaceId, initiatedByUserId: user.id })
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

    const job = await enqueueGenerateOutreach({ leadId, workspaceId: lead.workspaceId, initiatedByUserId: user.id })
    res.status(202).json({ jobId: job.id, queue: 'generate-outreach', status: 'queued' })
  })
)

jobsRouter.post(
  '/analyze-reply',
  aiRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const replyBody = String(req.body?.replyBody || '').trim()
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() || undefined : undefined
    const bodyWorkspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId.trim() || undefined : undefined

    if (!replyBody) throw new ApiError(400, 'replyBody required')
    if (replyBody.length > MAX_REPLY_BODY) throw new ApiError(400, `replyBody must be at most ${MAX_REPLY_BODY} characters`)
    // Require a billable scope. Previously leadId was optional and an omitted
    // leadId skipped metering entirely while the worker still ran the AI call —
    // an unmetered OpenAI spend path. Now every analyze-reply resolves to a
    // workspace and is charged before enqueue.
    if (!leadId && !bodyWorkspaceId) throw new ApiError(400, 'leadId or workspaceId required')

    let workspaceId: string
    if (leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId } })
      if (!lead) throw new ApiError(404, 'Lead not found')
      const member = await userBelongsToWorkspace(user.id, lead.workspaceId)
      if (!member) throw new ApiError(403, 'Access denied')
      workspaceId = lead.workspaceId
    } else {
      const member = await userBelongsToWorkspace(user.id, bodyWorkspaceId as string)
      if (!member) throw new ApiError(403, 'Access denied')
      workspaceId = bodyWorkspaceId as string
    }

    await checkAndIncrementAiUsage(workspaceId, 'AI_REPLY')

    const job = await enqueueAnalyzeReply({ replyBody, workspaceId, leadId, initiatedByUserId: user.id })
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

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

    const leads = await prisma.lead.findMany({
      where: { workspaceId, stage: 'NEW' },
      select: { id: true },
      take: 50
    })

    // Check usage before bulk queue (counts all at once)
    for (let i = 0; i < leads.length; i++) {
      await checkAndIncrementAiUsage(workspaceId, 'AI_RESEARCH')
    }

    const jobs = await Promise.all((leads as Array<{ id: string }>).map((l: { id: string }) => enqueueResearchLead({ leadId: l.id, workspaceId, initiatedByUserId: user.id })))
    res.status(202).json({ queued: jobs.length, jobs: jobs.map(j => ({ jobId: j.id, leadId: j.name })) })
  })
)

// Poll job status
jobsRouter.get(
  '/:queue/:jobId',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const queue = req.params.queue as string
    const jobId = req.params.jobId as string
    if (!QUEUE_NAMES.includes(queue)) throw new ApiError(400, `Unknown queue: ${queue}`)

    const job = await getJobById(queue, jobId)
    if (!job) throw new ApiError(404, 'Job not found')

    await assertCanReadJob(user.id, job)

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

