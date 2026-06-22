import { Router } from 'express'
import { requireAuth, requireVerifiedEmail, requireVerifiedForMutation } from '../middleware/auth.js'
import { requireFeature } from '../middleware/featureGate.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { enqueueSendCampaign } from '../lib/queues.js'
import { validate, parseQuery, parseParams, workspaceIdField, nonEmptyString, idField } from '../lib/validate.js'
import { z } from 'zod'
import { isProduction } from '../lib/config.js'
import { getSendReadiness } from '../lib/sendReadiness.js'
import { recordAudit } from '../lib/audit.js'
import { invalidateWorkspaceStats } from '../lib/statsCache.js'
import type { Assert, CreateCampaignRequest, Extends, LeadStage } from '@acaos/shared'

export const campaignsRouter = Router()
campaignsRouter.use(requireAuth)
campaignsRouter.use(requireVerifiedForMutation)

const GOAL_TYPES = ['BOOK_CALL', 'GET_REPLY', 'DRIVE_TRAFFIC', 'OTHER'] as const

const createCampaignSchema = z.object({
  workspaceId: workspaceIdField,
  name: nonEmptyString.max(200, 'name must be at most 200 characters'),
  goalType: z.enum(GOAL_TYPES).default('BOOK_CALL'),
  description: z.string().max(1000).optional(),
})

// Compile-time guard: the validated request must satisfy the shared contract the
// frontend is typed against. If the zod schema drifts from the contract, this fails.
type _CreateCampaignConforms = Assert<Extends<z.infer<typeof createCampaignSchema>, CreateCampaignRequest>>

// Shared query schema for the workspace-scoped GET endpoints. Mirrors the prior
// `String(req.query.workspaceId || '').trim()` + `if (!workspaceId) 400` pair:
// missing/blank produces a 400 'workspaceId required'.
const workspaceIdQuerySchema = z.object({
  workspaceId: z.string().trim().min(1, 'workspaceId required'),
})

// Route-param id for the /:id endpoints (replaces `req.params.id as string`).
const campaignParamsSchema = z.object({ id: idField })

// PATCH /:id body. Each field is optional; the handler still drops blanks and
// only updates provided fields (and 400s when nothing updatable remains).
const updateCampaignSchema = z.object({
  name: z.string().optional(),
  goalType: z.string().optional(),
  description: z.string().optional(),
})

// GET /:id/outreach pagination. Mirrors `Math.max(1, Number(page) || 1)` and
// `Math.min(100, Math.max(1, Number(limit) || 50))` exactly.
const outreachQuerySchema = z.object({
  page: z.unknown().optional().transform(v => Math.max(1, Number(v) || 1)),
  limit: z.unknown().optional().transform(v => Math.min(100, Math.max(1, Number(v) || 50))),
})

// POST /:id/send body. Both optional: leadIds restricts the send to specific
// leads (non-string elements are still filtered in the handler), approved is the
// approval-mode opt-in flag.
const sendCampaignSchema = z.object({
  leadIds: z.array(z.unknown()).optional(),
  approved: z.unknown().optional(),
})

// List campaigns for a workspace
campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceIdQuerySchema, req)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { leads: true } } }
    })

    res.json({ campaigns })
  })
)

// Send-readiness for a workspace — what's configured vs. missing before any send.
// Registered before /:id so "send-readiness" isn't matched as a campaign id.
campaignsRouter.get(
  '/send-readiness',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceIdQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')
    res.json(await getSendReadiness(workspaceId))
  })
)

// Workspace outbox health — surfaces sends that need operator attention:
// FAILED rows (with the SMTP error) and SENDING rows stuck past a threshold
// (a crash after dispatch leaves them SENDING; fail-closed = never auto-resent).
// Makes delivery trust visible instead of silently swallowing problems.
// Registered before /:id so "outbox-issues" isn't matched as a campaign id.
campaignsRouter.get(
  '/outbox-issues',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseQuery(workspaceIdQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    // SENDING older than this is "unknown delivery" — claimed but never confirmed.
    const stuckMinutes = 10
    const stuckBefore = new Date(Date.now() - stuckMinutes * 60_000)

    const select = { id: true, toEmail: true, subject: true, status: true, lastError: true, sentAt: true, campaignId: true } as const
    const [failed, stuck, failedCount, stuckCount] = await Promise.all([
      prisma.outreachSent.findMany({ where: { workspaceId, status: 'FAILED' }, orderBy: { sentAt: 'desc' }, take: 50, select }),
      prisma.outreachSent.findMany({ where: { workspaceId, status: 'SENDING', sentAt: { lt: stuckBefore } }, orderBy: { sentAt: 'desc' }, take: 50, select }),
      prisma.outreachSent.count({ where: { workspaceId, status: 'FAILED' } }),
      prisma.outreachSent.count({ where: { workspaceId, status: 'SENDING', sentAt: { lt: stuckBefore } } }),
    ])

    res.json({ failed, stuck, failedCount, stuckCount, stuckMinutes, hasIssues: failedCount + stuckCount > 0 })
  })
)

// Create campaign
campaignsRouter.post(
  '/',
  validate(createCampaignSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId, name, goalType, description } = req.body as z.infer<typeof createCampaignSchema>

    await assertWorkspacePermission(user.id, workspaceId, 'campaign:create')

    const campaign = await prisma.campaign.create({
      data: { workspaceId, name, goalType, description }
    })

    invalidateWorkspaceStats(workspaceId) // new campaign changes dashboard campaignCount
    void recordAudit({
      workspaceId, actorUserId: user.id, type: 'campaign.created',
      entityType: 'campaign', entityId: campaign.id,
    })
    res.status(201).json({ campaign })
  })
)

// Get campaign by id
campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id as string },
      include: { _count: { select: { leads: true } } }
    })

    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    res.json({ campaign })
  })
)

// Update campaign
campaignsRouter.patch(
  '/:id',
  validate(updateCampaignSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id: campaignId } = parseParams(campaignParamsSchema, req)
    const body = req.body as z.infer<typeof updateCampaignSchema>
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } })
    if (!existing) throw new ApiError(404, 'Campaign not found')

    await assertWorkspacePermission(user.id, existing.workspaceId, 'campaign:update')

    const updates: { name?: string; goalType?: string; description?: string } = {}
    if (typeof body.name === 'string' && body.name.trim()) {
      updates.name = body.name.trim()
    }
    if (typeof body.goalType === 'string' && body.goalType.trim()) {
      updates.goalType = body.goalType.trim()
    }
    if (typeof body.description === 'string') {
      updates.description = body.description.trim() || null as unknown as string
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No updatable fields provided')

    const campaign = await prisma.campaign.update({ where: { id: campaignId }, data: updates })
    void recordAudit({
      workspaceId: existing.workspaceId, actorUserId: user.id, type: 'campaign.updated',
      entityType: 'campaign', entityId: campaignId, metadata: { fields: Object.keys(updates) },
    })
    res.json({ campaign })
  })
)

// Campaign send stats
campaignsRouter.get(
  '/:id/stats',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id as string },
      include: { _count: { select: { leads: true } } }
    })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const TERMINAL = ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as const
    const [leadWithEmail, eligible, sent, replied, failed, bounced] = await Promise.all([
      prisma.lead.count({ where: { campaignId: campaign.id, email: { not: null } } }),
      prisma.lead.count({ where: { campaignId: campaign.id, email: { not: null }, stage: { notIn: [...TERMINAL] } } }),
      // Delivered sends only — exclude in-flight SENDING and never-sent FAILED.
      prisma.outreachSent.count({ where: { campaignId: campaign.id, status: { in: ['SENT', 'REPLIED', 'BOUNCED'] } } }),
      prisma.outreachSent.count({ where: { campaignId: campaign.id, status: 'REPLIED' } }),
      prisma.outreachSent.count({ where: { campaignId: campaign.id, status: 'FAILED' } }),
      prisma.outreachSent.count({ where: { campaignId: campaign.id, status: 'BOUNCED' } }),
    ])

    res.json({
      stats: {
        totalLeads: campaign._count.leads,
        leadsWithEmail: leadWithEmail,
        eligible,
        sent,
        replied,
        failed,
        bounced,
        replyRate: sent > 0 ? Math.round((replied / sent) * 100) / 100 : 0,
      }
    })
  })
)

// List outreach sent for a campaign
campaignsRouter.get(
  '/:id/outreach',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = parseParams(campaignParamsSchema, req)
    const campaign = await prisma.campaign.findUnique({ where: { id } })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const { page, limit } = parseQuery(outreachQuerySchema, req)

    const [outreach, total] = await Promise.all([
      prisma.outreachSent.findMany({
        where: { campaignId: campaign.id },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, toEmail: true, subject: true, status: true,
          sentAt: true, repliedAt: true, replyIntent: true, lastError: true, leadId: true,
        }
      }),
      prisma.outreachSent.count({ where: { campaignId: campaign.id } })
    ])

    res.json({ outreach, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

// Campaign send preflight — dry-run eligibility check without queueing.
// Shows exact count of leads eligible to send to, blockers if any, and estimated batches.
// Lets frontend decide whether to proceed or show "send blocked" UX.
campaignsRouter.get(
  '/:id/preflight',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id: campaignId } = parseParams(campaignParamsSchema, req)
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { _count: { select: { leads: true } } }
    })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    // Production deliverability gate (same as /send endpoint)
    const readiness = await getSendReadiness(campaign.workspaceId)
    const blockers: { name: string; hint: string }[] = []
    let ready = true

    if (isProduction() && !readiness.ready) {
      ready = false
      blockers.push({
        name: 'deliverabilityNotConfigured',
        hint: 'SMTP and CAN-SPAM sender identity (business name + postal address) must be configured'
      })
    }

    // Mission status check
    const mission = await prisma.mission.findUnique({
      where: { campaignId: campaign.id },
      select: { status: true }
    }).catch(() => null)

    if (mission?.status === 'PAUSED' || mission?.status === 'COMPLETE') {
      ready = false
      blockers.push({
        name: 'missionNotActive',
        hint: `Mission is ${mission.status.toLowerCase()} — resume or create a new mission before sending`
      })
    }

    // Eligible leads (basic: has email, not already reached terminal stage)
    const where = {
      campaignId: campaign.id,
      email: { not: null as null },
      stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as LeadStage[] },
    }
    const totalEligible = await prisma.lead.count({ where })

    // Approval mode check
    const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId: campaign.workspaceId } })
    let approvedEligible = totalEligible

    if (icp?.approvalMode) {
      approvedEligible = await prisma.lead.count({
        where: { ...where, outreachDrafts: { some: { status: 'APPROVED' } } }
      })
      if (approvedEligible === 0) {
        ready = false
        blockers.push({
          name: 'noApprovedDrafts',
          hint: 'Approval mode enabled — approve at least one outreach in the Review Queue before sending'
        })
      }
    }

    // Daily cap check
    let cappedEligible = approvedEligible
    let cappedByDaily = false

    if (icp?.dailySendLimit && icp.dailySendLimit > 0) {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const sentToday = await prisma.outreachSent.count({
        where: { workspaceId: campaign.workspaceId, status: 'SENT', sentAt: { gte: startOfToday } }
      })
      const remaining = Math.max(0, icp.dailySendLimit - sentToday)

      if (remaining === 0) {
        ready = false
        blockers.push({
          name: 'dailyCapReached',
          hint: `Daily send limit of ${icp.dailySendLimit} reached for today — ${approvedEligible} eligible leads will send tomorrow`
        })
      } else if (remaining < approvedEligible) {
        cappedEligible = remaining
        cappedByDaily = true
      }
    }

    // Estimate batches (default: 100 leads per batch, configurable)
    const batchSize = 100
    const estimatedDailyBatches = Math.ceil(cappedEligible / batchSize)

    res.json({
      campaignId: campaign.id,
      totalLeads: campaign._count.leads,
      totalEligible: totalEligible,
      approvedEligible: approvedEligible,
      cappedEligible: cappedEligible,
      cappedByDaily,
      requiresApproval: icp?.approvalMode ?? false,
      dailySendLimit: icp?.dailySendLimit || null,
      estimatedDailyBatches,
      ready,
      blockers,
      message: ready
        ? `${cappedEligible} lead${cappedEligible !== 1 ? 's' : ''} ready to send${cappedByDaily ? ` (capped by daily limit of ${icp?.dailySendLimit})` : ''}`
        : `Send blocked: ${blockers.map(b => b.name).join(', ')}`
    })
  })
)

// Launch campaign — enqueues batch email send for all leads with email addresses.
// Optional body: { leadIds?: string[] } to restrict to specific leads.
// Returns a jobId for progress polling via GET /api/jobs/:queue/:id.
campaignsRouter.post(
  '/:id/send',
  requireVerifiedEmail,
  requireFeature('send'),
  validate(sendCampaignSchema),
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id: campaignId } = parseParams(campaignParamsSchema, req)
    const body = req.body as z.infer<typeof sendCampaignSchema>
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { _count: { select: { leads: true } } }
    })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    await assertWorkspacePermission(user.id, campaign.workspaceId, 'campaign:send')

    // Production send-readiness / compliance gate. The frontend checks SPF/DKIM
    // and sender setup before launch, but a direct API caller must not be able to
    // bypass it. Enforced only in production so local/dev/test stays frictionless.
    // Same getSendReadiness() that powers the onboarding panel — one source of truth.
    if (isProduction()) {
      const readiness = await getSendReadiness(campaign.workspaceId)
      if (!readiness.ready) {
        return res.status(422).json({
          error: 'DELIVERABILITY_BLOCKED',
          message: 'Sending is blocked until SMTP and CAN-SPAM sender identity (business name + postal address) are configured.',
          checks: readiness.checks,
        })
      }
    }

    // Resolve which leads to send to — filter to string IDs only so non-string
    // elements (numbers, objects) from untrusted input don't reach Prisma.
    const requestedIds: string[] | undefined = Array.isArray(body.leadIds)
      ? (body.leadIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined

    const where = {
      campaignId: campaign.id,
      email: { not: null as null },
      stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as LeadStage[] },
      ...(requestedIds ? { id: { in: requestedIds } } : {})
    }

    let eligible = await prisma.lead.count({ where })
    if (eligible === 0) throw new ApiError(400, 'No eligible leads with email addresses in this campaign')

    // Enforce mission stop-control, approval mode, and daily send limit before
    // enqueue, so a direct API caller can't bypass the controls the UI presents.
    const [icp, mission] = await Promise.all([
      prisma.workspaceICP.findUnique({ where: { workspaceId: campaign.workspaceId } }),
      prisma.mission.findUnique({ where: { campaignId: campaign.id }, select: { status: true } }).catch(() => null),
    ])

    // A paused/completed mission is an operator stop button — honour it before sending.
    if (mission?.status === 'PAUSED' || mission?.status === 'COMPLETE') {
      throw new ApiError(409, `Mission is ${mission.status.toLowerCase()} — resume or create a new mission before sending`)
    }

    if (icp?.approvalMode) {
      // Approval mode: require explicit opt-in flag in the request body.
      // The frontend sends { approved: true } after the user confirms the modal.
      if (!body.approved) {
        throw new ApiError(403, 'Approval required — send { approved: true } to confirm dispatch')
      }
      // This product reviews drafts per-lead (Review Queue → APPROVED) and the
      // worker only sends APPROVED drafts in approval mode. So require at least
      // one lead with an approved draft, otherwise we'd accept a launch the
      // worker silently sends nothing for.
      const approvedEligible = await prisma.lead.count({
        where: { ...where, outreachDrafts: { some: { status: 'APPROVED' } } },
      })
      if (approvedEligible === 0) {
        throw new ApiError(400, 'No approved drafts to send — approve outreach in the Review Queue first')
      }
      eligible = approvedEligible
    }

    let cappedEligible = eligible
    if (icp?.dailySendLimit && icp.dailySendLimit > 0) {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const sentToday = await prisma.outreachSent.count({
        // Count delivered sends only — in-flight (SENDING) / FAILED outbox claims
        // are fail-closed safety rows and must not consume the daily send cap.
        where: { workspaceId: campaign.workspaceId, status: 'SENT', sentAt: { gte: startOfToday } }
      })
      const remaining = Math.max(0, icp.dailySendLimit - sentToday)
      if (remaining === 0) {
        throw new ApiError(429, `Daily send limit of ${icp.dailySendLimit} reached for today`)
      }
      cappedEligible = Math.min(eligible, remaining)
    }

    const job = await enqueueSendCampaign(
      campaign.id,
      campaign.workspaceId,
      requestedIds,
      req.id
    )

    void recordAudit({
      workspaceId: campaign.workspaceId,
      actorUserId: user.id,
      type: 'campaign.send',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: { eligible: cappedEligible, jobId: job.id },
    })

    res.status(202).json({
      jobId: job.id,
      queue: 'send-campaign',
      eligible: cappedEligible,
      dailyCapApplied: cappedEligible < eligible,
      // `eligible` is a forecast, not a guarantee: the worker re-checks the daily
      // cap against a LIVE count at dispatch and is the single enforcer, so the
      // number actually sent can be lower if other campaigns consumed the cap in
      // the meantime. The message says so rather than promising an exact count.
      message: `Queued ${cappedEligible} of ${eligible} eligible lead${eligible !== 1 ? 's' : ''} for today — the worker enforces your daily send cap at dispatch and sends any remainder on the next run. Poll /api/jobs/send-campaign/${job.id} for status.`
    })
  })
)

// Delete campaign
campaignsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const campaignId = req.params.id as string
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } })
    if (!existing) throw new ApiError(404, 'Campaign not found')

    await assertWorkspacePermission(user.id, existing.workspaceId, 'campaign:delete')

    await prisma.campaign.delete({ where: { id: campaignId } })
    // Deleting a campaign changes campaignCount and (via cascade) lead totals/funnel.
    invalidateWorkspaceStats(existing.workspaceId)
    void recordAudit({
      workspaceId: existing.workspaceId, actorUserId: user.id, type: 'campaign.deleted',
      entityType: 'campaign', entityId: campaignId,
    })
    res.json({ ok: true })
  })
)

// Operator escape hatch for the fail-closed outbox: clear FAILED send rows so the
// affected leads become re-sendable on the next launch (which re-runs all the
// deliverability/approval gates). FAILED rows are otherwise terminal.
campaignsRouter.post(
  '/:id/retry-failed',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const campaignId = req.params.id as string
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    await assertWorkspacePermission(user.id, campaign.workspaceId, 'campaign:retry_failed')

    const result = await prisma.outreachSent.deleteMany({
      where: { campaignId: campaign.id, status: 'FAILED' },
    })
    if (result.count > 0) {
      void recordAudit({
        workspaceId: campaign.workspaceId, actorUserId: user.id, type: 'campaign.retry_failed',
        entityType: 'campaign', entityId: campaign.id, metadata: { cleared: result.count },
      })
    }
    res.json({ cleared: result.count })
  })
)
