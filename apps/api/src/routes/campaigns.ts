import { Router } from 'express'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { enqueueSendCampaign, getJobById } from '../lib/queues.js'
import { validate, workspaceIdField, nonEmptyString } from '../lib/validate.js'
import { z } from 'zod'
import { isProduction } from '../lib/config.js'
import { isMailConfigured } from '../services/mail.js'
import { recordAudit } from '../lib/audit.js'
import type { AuthedRequest } from '../types/auth.js'
import type { LeadStage } from '@prisma/client'
import type { Assert, Extends, CreateCampaignRequest } from '@acaos/shared'

export const campaignsRouter = Router()
campaignsRouter.use(requireAuth)

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

// List campaigns for a workspace
campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

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

// Create campaign
campaignsRouter.post(
  '/',
  validate(createCampaignSchema),
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { workspaceId, name, goalType, description } = req.body as z.infer<typeof createCampaignSchema>

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaign = await prisma.campaign.create({
      data: { workspaceId, name, goalType, description }
    })

    res.status(201).json({ campaign })
  })
)

// Get campaign by id
campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
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
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const campaignId = req.params.id as string
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } })
    if (!existing) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, existing.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const updates: { name?: string; goalType?: string; description?: string } = {}
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      updates.name = req.body.name.trim()
    }
    if (typeof req.body?.goalType === 'string' && req.body.goalType.trim()) {
      updates.goalType = req.body.goalType.trim()
    }
    if (typeof req.body?.description === 'string') {
      updates.description = req.body.description.trim() || null as unknown as string
    }

    if (Object.keys(updates).length === 0) throw new ApiError(400, 'No updatable fields provided')

    const campaign = await prisma.campaign.update({ where: { id: campaignId }, data: updates })
    res.json({ campaign })
  })
)

// Campaign send stats
campaignsRouter.get(
  '/:id/stats',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
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
    const user = (req as AuthedRequest).user
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id as string } })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const page  = Math.max(1, Number(req.query.page)  || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))

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

// Launch campaign — enqueues batch email send for all leads with email addresses.
// Optional body: { leadIds?: string[] } to restrict to specific leads.
// Returns a jobId for progress polling via GET /api/jobs/:queue/:id.
campaignsRouter.post(
  '/:id/send',
  requireVerifiedEmail,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id as string },
      include: { _count: { select: { leads: true } } }
    })
    if (!campaign) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, campaign.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    // Production send-readiness / compliance gate. The frontend checks SPF/DKIM
    // and sender setup before launch, but a direct API caller must not be able to
    // bypass it. Enforced only in production so local/dev/test stays frictionless.
    if (isProduction()) {
      const [emailCfg, ws] = await Promise.all([
        prisma.workspaceEmailConfig.findUnique({ where: { workspaceId: campaign.workspaceId } }),
        prisma.workspace.findUnique({
          where: { id: campaign.workspaceId },
          select: { senderBusinessName: true, senderPostalAddress: true },
        }),
      ])
      const checks = [
        { name: 'smtpConfigured', ok: isMailConfigured(emailCfg ?? undefined) },
        { name: 'senderBusinessName', ok: Boolean(ws?.senderBusinessName?.trim()) },
        { name: 'senderPostalAddress', ok: Boolean(ws?.senderPostalAddress?.trim()) },
      ]
      if (checks.some((c) => !c.ok)) {
        return res.status(422).json({
          error: 'DELIVERABILITY_BLOCKED',
          message: 'Sending is blocked until SMTP and CAN-SPAM sender identity (business name + postal address) are configured.',
          checks,
        })
      }
    }

    // Resolve which leads to send to — filter to string IDs only so non-string
    // elements (numbers, objects) from untrusted input don't reach Prisma.
    const requestedIds: string[] | undefined = Array.isArray(req.body?.leadIds)
      ? (req.body.leadIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined

    const where = {
      campaignId: campaign.id,
      email: { not: null as null },
      stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] as LeadStage[] },
      ...(requestedIds ? { id: { in: requestedIds } } : {})
    }

    const eligible = await prisma.lead.count({ where })
    if (eligible === 0) throw new ApiError(400, 'No eligible leads with email addresses in this campaign')

    // Enforce daily send limit and approval mode from workspace ICP
    const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId: campaign.workspaceId } })

    if (icp?.approvalMode) {
      // Approval mode: require explicit opt-in flag in the request body.
      // The frontend sends { approved: true } after the user confirms the modal.
      if (!req.body?.approved) {
        throw new ApiError(403, 'Approval required — send { approved: true } to confirm dispatch')
      }
    }

    let cappedEligible = eligible
    if (icp?.dailySendLimit && icp.dailySendLimit > 0) {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const sentToday = await prisma.outreachSent.count({
        where: { workspaceId: campaign.workspaceId, sentAt: { gte: startOfToday } }
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
      requestedIds
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
      message: `Sending to ${cappedEligible} lead${cappedEligible !== 1 ? 's' : ''} — poll /api/jobs/send-campaign/${job.id} for status`
    })
  })
)

// Delete campaign
campaignsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const campaignId = req.params.id as string
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } })
    if (!existing) throw new ApiError(404, 'Campaign not found')

    const member = await userBelongsToWorkspace(user.id, existing.workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    await prisma.campaign.delete({ where: { id: campaignId } })
    res.json({ ok: true })
  })
)
