import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { validate, workspaceIdField, nonEmptyString } from '../lib/validate.js'
import { z } from 'zod'
import { recordAudit } from '../lib/audit.js'
import { getPack } from '../lib/packs/index.js'
import type { AuthedRequest } from '../types/auth.js'
import type { Assert, Extends, CreateMissionRequest, UpdateMissionRequest } from '@acaos/shared'

export const missionsRouter = Router()
missionsRouter.use(requireAuth)

const GOAL_TYPES = ['BOOK_CALL', 'GET_REPLY', 'DRIVE_TRAFFIC', 'OTHER'] as const
const MISSION_STATUSES = ['DRAFT', 'DISCOVERING', 'REVIEWING', 'ACTIVE', 'PAUSED', 'COMPLETE'] as const

const createMissionSchema = z.object({
  workspaceId: workspaceIdField,
  name: nonEmptyString.max(200, 'name must be at most 200 characters'),
  goalType: z.enum(GOAL_TYPES).default('BOOK_CALL'),
  targetCustomer: z.string().max(2000).optional(),
  offer: z.string().max(2000).optional(),
  playbookId: z.string().max(100).nullish(),
})

const updateMissionSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  status: z.enum(MISSION_STATUSES).optional(),
})

// Compile-time guards: the validated requests must satisfy the shared contracts.
type _CreateConforms = Assert<Extends<z.infer<typeof createMissionSchema>, CreateMissionRequest>>
type _UpdateConforms = Assert<Extends<z.infer<typeof updateMissionSchema>, UpdateMissionRequest>>

// List missions for a workspace, with their linked campaign + lead counts.
missionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const missions = await prisma.mission.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { campaign: { include: { _count: { select: { leads: true } } } } },
    })

    // Per-mission discovery activity: how many runs sourced prospects for this
    // mission and how many prospects they imported in total.
    const missionIds = missions.map(m => m.id)
    const discoveryByMission = new Map<string, { runs: number; discovered: number }>()
    if (missionIds.length > 0) {
      const grouped = await prisma.discoveryRun.groupBy({
        by: ['missionId'],
        where: { missionId: { in: missionIds } },
        _count: { _all: true },
        _sum: { importedCount: true },
      })
      for (const g of grouped as Array<{ missionId: string | null; _count: { _all: number }; _sum: { importedCount: number | null } }>) {
        if (g.missionId) discoveryByMission.set(g.missionId, { runs: g._count._all, discovered: g._sum.importedCount ?? 0 })
      }
    }

    // Per-mission execution outcomes from the linked campaign's outbox — the
    // mission as a control plane shows what actually happened, not just leads.
    const campaignIds = missions.map(m => m.campaignId).filter((id): id is string => Boolean(id))
    const statsByCampaign = new Map<string, { sent: number; replied: number; failed: number; bounced: number; pendingDrafts: number }>()
    const get = (cid: string) => {
      let s = statsByCampaign.get(cid)
      if (!s) { s = { sent: 0, replied: 0, failed: 0, bounced: 0, pendingDrafts: 0 }; statsByCampaign.set(cid, s) }
      return s
    }
    if (campaignIds.length > 0) {
      const [grouped, pendingDrafts] = await Promise.all([
        prisma.outreachSent.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: campaignIds } }, _count: true }),
        // Drafts awaiting review for this mission's campaign leads (the actionable backlog).
        prisma.outreachDraft.findMany({
          where: { workspaceId, status: 'DRAFTED', lead: { campaignId: { in: campaignIds } } },
          select: { lead: { select: { campaignId: true } } },
        }),
      ])
      for (const g of grouped as Array<{ campaignId: string | null; status: string; _count: number }>) {
        if (!g.campaignId) continue
        const s = get(g.campaignId)
        if (g.status === 'SENT' || g.status === 'REPLIED' || g.status === 'BOUNCED') s.sent += g._count
        if (g.status === 'REPLIED') s.replied += g._count
        if (g.status === 'FAILED') s.failed += g._count
        if (g.status === 'BOUNCED') s.bounced += g._count
      }
      for (const d of pendingDrafts as Array<{ lead: { campaignId: string | null } | null }>) {
        const cid = d.lead?.campaignId
        if (cid) get(cid).pendingDrafts += 1
      }
    }
    const zero = { sent: 0, replied: 0, failed: 0, bounced: 0, pendingDrafts: 0 }
    const zeroDiscovery = { runs: 0, discovered: 0 }
    const withStats = missions.map(m => ({
      ...m,
      stats: m.campaignId ? (statsByCampaign.get(m.campaignId) ?? zero) : zero,
      discovery: discoveryByMission.get(m.id) ?? zeroDiscovery,
    }))

    res.json({ missions: withStats })
  })
)

// Mission control plane: the mission + its playbook, recent discovery activity,
// the prospects it owns, and the actionable outreach queue scoped to it.
missionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const mission = await prisma.mission.findUnique({
      where: { id: req.params.id as string },
      include: { campaign: { include: { _count: { select: { leads: true } } } } },
    })
    if (!mission) throw new ApiError(404, 'Mission not found')
    if (!(await userBelongsToWorkspace(user.id, mission.workspaceId))) throw new ApiError(403, 'Access denied')

    const pack = mission.playbookId ? getPack(mission.playbookId) : undefined
    const playbook = pack ? { id: pack.id, label: pack.label, description: pack.description } : null

    const [discoveryRuns, prospects, intents] = await Promise.all([
      prisma.discoveryRun.findMany({
        where: { missionId: mission.id },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: {
          id: true, source: true, status: true, resultCount: true, importedCount: true,
          skippedCount: true, errorCode: true, errorMessage: true, startedAt: true, finishedAt: true,
        },
      }),
      prisma.prospect.findMany({
        where: { missionId: mission.id },
        orderBy: { opportunityScore: 'desc' },
        take: 10,
        select: { id: true, companyName: true, industry: true, opportunityScore: true, buyingStage: true },
      }),
      // The mission's action queue: outreach not yet sent/closed, joined to its
      // prospect + recommendation, strongest opportunity first.
      prisma.outreachIntent.findMany({
        where: { missionId: mission.id, status: { in: ['PROPOSED', 'DRAFTED', 'APPROVED'] } },
        orderBy: { createdAt: 'desc' },
        take: 25,
        include: {
          prospect: { select: { id: true, companyName: true, industry: true, opportunityScore: true, buyingStage: true } },
          recommendation: { select: { reasoning: true, actionText: true, urgency: true, priority: true } },
        },
      }),
    ])
    intents.sort((a, b) => (b.prospect?.opportunityScore ?? 0) - (a.prospect?.opportunityScore ?? 0))

    res.json({ mission, playbook, discoveryRuns, prospects, intents })
  })
)

// Create a mission AND its execution campaign in one transaction. The campaign is
// what leads/outreach attach to; the mission is the control plane around it.
missionsRouter.post(
  '/',
  validate(createMissionSchema),
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const { workspaceId, name, goalType, targetCustomer, offer, playbookId } = req.body as z.infer<typeof createMissionSchema>
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const description = [targetCustomer && `Target: ${targetCustomer}`, offer && `Offer: ${offer}`]
      .filter(Boolean)
      .join('\n') || null

    const mission = await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: { workspaceId, name, goalType, description },
      })
      return tx.mission.create({
        data: {
          workspaceId, name, goalType,
          targetCustomer: targetCustomer ?? null,
          offer: offer ?? null,
          playbookId: playbookId ?? null,
          campaignId: campaign.id,
        },
        include: { campaign: { include: { _count: { select: { leads: true } } } } },
      })
    })

    void recordAudit({
      workspaceId, actorUserId: user.id, type: 'mission.create',
      entityType: 'mission', entityId: mission.id, metadata: { name, goalType },
    })

    res.status(201).json({ mission, campaign: mission.campaign })
  })
)

missionsRouter.patch(
  '/:id',
  validate(updateMissionSchema),
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const existing = await prisma.mission.findUnique({ where: { id: req.params.id as string } })
    if (!existing) throw new ApiError(404, 'Mission not found')
    if (!(await userBelongsToWorkspace(user.id, existing.workspaceId))) throw new ApiError(403, 'Access denied')

    const { name, status } = req.body as z.infer<typeof updateMissionSchema>
    const mission = await prisma.mission.update({
      where: { id: existing.id },
      data: { ...(name !== undefined ? { name } : {}), ...(status !== undefined ? { status } : {}) },
      include: { campaign: { include: { _count: { select: { leads: true } } } } },
    })
    if (status !== undefined) {
      void recordAudit({
        workspaceId: existing.workspaceId, actorUserId: user.id, type: 'mission.status',
        entityType: 'mission', entityId: existing.id, metadata: { status },
      })
    }
    res.json({ mission })
  })
)
