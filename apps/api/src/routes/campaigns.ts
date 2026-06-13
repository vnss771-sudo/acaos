import { Router } from 'express'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { enqueueSendCampaign, getJobById } from '../lib/queues.js'
import type { AuthedRequest } from '../types/auth.js'

export const campaignsRouter = Router()
campaignsRouter.use(requireAuth)

const MAX_NAME = 200

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
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const name = String(req.body?.name || '').trim()
    const goalType = String(req.body?.goalType || 'BOOK_CALL').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!name) throw new ApiError(400, 'name required')
    if (name.length > MAX_NAME) throw new ApiError(400, `name must be at most ${MAX_NAME} characters`)

    const member = await userBelongsToWorkspace(user.id, workspaceId)
    if (!member) throw new ApiError(403, 'Access denied')

    const campaign = await prisma.campaign.create({
      data: { workspaceId, name, goalType }
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
    const [leadWithEmail, eligible, sent, replied] = await Promise.all([
      prisma.lead.count({ where: { campaignId: campaign.id, email: { not: null } } }),
      prisma.lead.count({ where: { campaignId: campaign.id, email: { not: null }, stage: { notIn: [...TERMINAL] } } }),
      prisma.outreachSent.count({ where: { campaignId: campaign.id } }),
      prisma.outreachSent.count({ where: { campaignId: campaign.id, status: 'REPLIED' } }),
    ])

    res.json({
      stats: {
        totalLeads: campaign._count.leads,
        leadsWithEmail: leadWithEmail,
        eligible,
        sent,
        replied,
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
          sentAt: true, repliedAt: true, replyIntent: true, leadId: true,
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

    // Resolve which leads to send to — filter to string IDs only so non-string
    // elements (numbers, objects) from untrusted input don't reach Prisma.
    const requestedIds: string[] | undefined = Array.isArray(req.body?.leadIds)
      ? (req.body.leadIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined

    const where = {
      campaignId: campaign.id,
      email: { not: null as null },
      stage: { notIn: ['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'] },
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
