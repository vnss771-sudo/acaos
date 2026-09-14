import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../../lib/validate.js'
import { assertOwnership, clampPagination, utcWeekRange, auditOps } from './utils.js'
import type {
  Assert,
  Extends,
  OpsCreateRosterEntryRequest,
  OpsBulkCreateRosterRequest,
  OpsUpdateRosterEntryRequest,
  OpsPublishRosterRequest,
} from '@acaos/shared'

// Roster entries: planned (not-yet-worked) shift assignments, distinct from
// OpsShiftRecord (the actual worked record clock.ts produces). Reading is
// member-level; every mutation is 'ops:manage'.
export const rosterRouter = Router()
rosterRouter.use(requireAuth)
rosterRouter.use(requireVerifiedForMutation)

function isP2002(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002'
}

// ── list ─────────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

rosterRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')
    const { page, limit, skip } = clampPagination(q.page, q.limit)

    const where = {
      workspaceId: q.workspaceId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to ? { rosterDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    }

    const [entries, total] = await Promise.all([
      prisma.opsRosterEntry.findMany({ where, orderBy: [{ rosterDate: 'asc' }, { startTime: 'asc' }], skip, take: limit }),
      prisma.opsRosterEntry.count({ where }),
    ])

    res.json({ entries, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

// ── create (single) ──────────────────────────────────────────────────────────

const shiftTypeEnum = z.enum(['REGULAR', 'OVERTIME', 'CALLOUT', 'ON_CALL'])

const createSchema = z.object({
  workspaceId: workspaceIdField,
  crewMemberId: idField,
  jobSiteId: idField,
  rosterDate: z.string().datetime(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  shiftType: shiftTypeEnum.optional(),
  notes: z.string().trim().max(2000).optional(),
})
type _CreateRosterConforms = Assert<Extends<z.infer<typeof createSchema>, OpsCreateRosterEntryRequest>>

rosterRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const data = parseBody(createSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')
    if (new Date(data.endTime) <= new Date(data.startTime)) throw new ApiError(400, 'endTime must be after startTime')
    await assertOwnership(data.workspaceId, { crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId })

    try {
      const entry = await prisma.opsRosterEntry.create({
        data: {
          workspaceId: data.workspaceId, crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId,
          rosterDate: new Date(data.rosterDate), startTime: new Date(data.startTime), endTime: new Date(data.endTime),
          shiftType: data.shiftType ?? 'REGULAR', status: 'DRAFT', notes: data.notes,
        },
      })
      auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.roster.created', entityType: 'OpsRosterEntry', entityId: entry.id })
      res.status(201).json({ entry })
    } catch (err) {
      if (isP2002(err)) throw new ApiError(409, 'This crew member is already rostered for that date and start time')
      throw err
    }
  })
)

// ── bulk create ──────────────────────────────────────────────────────────────

const bulkEntrySchema = z.object({
  crewMemberId: idField,
  jobSiteId: idField,
  rosterDate: z.string().datetime(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  shiftType: shiftTypeEnum.optional(),
  notes: z.string().trim().max(2000).optional(),
})

const bulkSchema = z.object({
  workspaceId: workspaceIdField,
  entries: z.array(bulkEntrySchema).min(1).max(200),
})
type _BulkRosterConforms = Assert<Extends<z.infer<typeof bulkSchema>, OpsBulkCreateRosterRequest>>

// POST /bulk — build a week's roster at once. Validates every referenced
// crewMemberId/jobSiteId belongs to the workspace with two batched existence
// checks (not one assertOwnership call per entry — that would be an N+1 over
// the whole batch). Uses createMany with skipDuplicates so one entry colliding
// with an existing (workspaceId, crewMemberId, rosterDate, startTime) row
// doesn't fail the entire batch — the response reports how many actually landed.
rosterRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, entries } = parseBody(bulkSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    for (let i = 0; i < entries.length; i += 1) {
      if (new Date(entries[i]!.endTime) <= new Date(entries[i]!.startTime)) {
        throw new ApiError(400, `entries[${i}]: endTime must be after startTime`)
      }
    }

    const crewMemberIds = [...new Set(entries.map((e) => e.crewMemberId))]
    const jobSiteIds = [...new Set(entries.map((e) => e.jobSiteId))]
    const [foundCrew, foundSites] = await Promise.all([
      prisma.opsCrewMember.findMany({ where: { id: { in: crewMemberIds }, workspaceId }, select: { id: true } }),
      prisma.opsJobSite.findMany({ where: { id: { in: jobSiteIds }, workspaceId }, select: { id: true } }),
    ])
    const foundCrewIds = new Set(foundCrew.map((c) => c.id))
    const foundSiteIds = new Set(foundSites.map((s) => s.id))
    const missingCrew = crewMemberIds.filter((id) => !foundCrewIds.has(id))
    const missingSites = jobSiteIds.filter((id) => !foundSiteIds.has(id))
    if (missingCrew.length || missingSites.length) {
      throw new ApiError(404, `Unknown crew member(s) or job site(s) for this workspace: ${[...missingCrew, ...missingSites].join(', ')}`)
    }

    const result = await prisma.opsRosterEntry.createMany({
      data: entries.map((e) => ({
        workspaceId, crewMemberId: e.crewMemberId, jobSiteId: e.jobSiteId,
        rosterDate: new Date(e.rosterDate), startTime: new Date(e.startTime), endTime: new Date(e.endTime),
        shiftType: e.shiftType ?? 'REGULAR', status: 'DRAFT' as const, notes: e.notes,
      })),
      skipDuplicates: true,
    })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.roster.bulk_created', entityType: 'OpsRosterEntry', entityId: workspaceId, metadata: { requested: entries.length, created: result.count } })

    res.status(201).json({ created: result.count, requested: entries.length })
  })
)

// ── update / delete (DRAFT only) ─────────────────────────────────────────────

const idParamsSchema = z.object({ id: idField })

const updateSchema = z.object({
  workspaceId: workspaceIdField,
  jobSiteId: idField.optional(),
  rosterDate: z.string().datetime().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  shiftType: shiftTypeEnum.optional(),
  notes: z.string().trim().max(2000).optional(),
})
type _UpdateRosterConforms = Assert<Extends<z.infer<typeof updateSchema>, OpsUpdateRosterEntryRequest>>

rosterRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const data = parseBody(updateSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')

    const existing = await prisma.opsRosterEntry.findFirst({ where: { id, workspaceId: data.workspaceId } })
    if (!existing) throw new ApiError(404, 'Roster entry not found')
    if (existing.status === 'PUBLISHED') throw new ApiError(400, 'Cannot edit a published roster entry')
    if (data.jobSiteId) await assertOwnership(data.workspaceId, { jobSiteId: data.jobSiteId })

    const startTime = data.startTime ? new Date(data.startTime) : existing.startTime
    const endTime = data.endTime ? new Date(data.endTime) : existing.endTime
    if (endTime <= startTime) throw new ApiError(400, 'endTime must be after startTime')

    try {
      const updated = await prisma.opsRosterEntry.update({
        where: { id },
        data: {
          ...(data.jobSiteId ? { jobSiteId: data.jobSiteId } : {}),
          ...(data.rosterDate ? { rosterDate: new Date(data.rosterDate) } : {}),
          ...(data.startTime ? { startTime } : {}),
          ...(data.endTime ? { endTime } : {}),
          ...(data.shiftType ? { shiftType: data.shiftType } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      })
      auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.roster.updated', entityType: 'OpsRosterEntry', entityId: id })
      res.json({ entry: updated })
    } catch (err) {
      if (isP2002(err)) throw new ApiError(409, 'This crew member is already rostered for that date and start time')
      throw err
    }
  })
)

const deleteQuerySchema = z.object({ workspaceId: workspaceIdField })

rosterRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(deleteQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const existing = await prisma.opsRosterEntry.findFirst({ where: { id, workspaceId } })
    if (!existing) throw new ApiError(404, 'Roster entry not found')
    if (existing.status === 'PUBLISHED') throw new ApiError(400, 'Cannot delete a published roster entry')

    await prisma.opsRosterEntry.delete({ where: { id } })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.roster.deleted', entityType: 'OpsRosterEntry', entityId: id })
    res.json({ deleted: true, id })
  })
)

// ── publish ──────────────────────────────────────────────────────────────────

const publishSchema = z.object({ workspaceId: workspaceIdField, from: z.string().datetime(), to: z.string().datetime() })
type _PublishRosterConforms = Assert<Extends<z.infer<typeof publishSchema>, OpsPublishRosterRequest>>

// POST /publish — bulk-commits every DRAFT entry in [from, to] to PUBLISHED in
// one updateMany round trip (not a per-row loop).
rosterRouter.post(
  '/publish',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, from, to } = parseBody(publishSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const result = await prisma.opsRosterEntry.updateMany({
      where: { workspaceId, status: 'DRAFT', rosterDate: { gte: new Date(from), lte: new Date(to) } },
      data: { status: 'PUBLISHED', publishedBy: user.id, publishedAt: new Date() },
    })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.roster.published', entityType: 'OpsRosterEntry', entityId: workspaceId, metadata: { from, to, count: result.count } })

    res.json({ published: result.count })
  })
)

// ── summary ──────────────────────────────────────────────────────────────────

const summaryQuerySchema = z.object({ workspaceId: workspaceIdField })

rosterRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(summaryQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const { start, end } = utcWeekRange(new Date())
    const [draftCount, publishedThisWeekCount, activeJobSiteCount] = await Promise.all([
      prisma.opsRosterEntry.count({ where: { workspaceId, status: 'DRAFT' } }),
      prisma.opsRosterEntry.count({ where: { workspaceId, status: 'PUBLISHED', rosterDate: { gte: start, lt: end } } }),
      prisma.opsJobSite.count({ where: { workspaceId, status: { not: 'ARCHIVED' } } }),
    ])

    res.json({ draftCount, publishedThisWeekCount, activeJobSiteCount })
  })
)
