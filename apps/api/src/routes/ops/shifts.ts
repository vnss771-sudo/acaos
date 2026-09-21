import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../../lib/validate.js'
import { assertOwnership, clampPagination, reconcileShiftAlerts, auditOps, totalHoursFor } from './utils.js'
import type { Assert, Extends, OpsCreateShiftRequest, OpsUpdateShiftRequest } from '@acaos/shared'

// Shift records: clock in/out produces these (see clock.ts); this router covers
// listing history and admin-entered manual corrections/backfills. Reading is
// member-level; every mutation is 'ops:manage' (admin+) and re-validates that
// any crewMemberId/jobSiteId in the body actually belongs to the caller's
// workspace — the resource-ownership half of tenant isolation that
// assertWorkspacePermission(workspaceId) alone doesn't cover.
export const shiftsRouter = Router()
shiftsRouter.use(requireAuth)
shiftsRouter.use(requireVerifiedForMutation)

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  crewMemberId: idField.optional(),
  jobSiteId: idField.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

// GET /api/ops/shifts — shift history, filterable and paginated.
shiftsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')
    const { page, limit, skip } = clampPagination(q.page, q.limit)

    const where = {
      workspaceId: q.workspaceId,
      ...(q.crewMemberId ? { crewMemberId: q.crewMemberId } : {}),
      ...(q.jobSiteId ? { jobSiteId: q.jobSiteId } : {}),
      ...(q.from || q.to ? { shiftDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    }

    const [shifts, total] = await Promise.all([
      prisma.opsShiftRecord.findMany({
        where, orderBy: [{ shiftDate: 'desc' }, { startTime: 'desc' }], skip, take: limit,
        include: {
          crewMember: { select: { id: true, fullName: true, employeeCode: true } },
          jobSite: { select: { id: true, siteName: true, jobCode: true } },
        },
      }),
      prisma.opsShiftRecord.count({ where }),
    ])

    res.json({ shifts, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

const createSchema = z.object({
  workspaceId: workspaceIdField,
  crewMemberId: idField,
  jobSiteId: idField,
  shiftDate: z.string().datetime(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  breakMinutes: z.number().int().min(0).max(1440).optional(),
  allowanceTag: z.string().trim().max(64).optional(),
  outdoorHighRisk: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
})
type _CreateShiftConforms = Assert<Extends<z.infer<typeof createSchema>, OpsCreateShiftRequest>>

// POST /api/ops/shifts — manual entry (backfill/correction). Live clock in/out
// goes through clock.ts, which enforces the one-open-shift-per-crew-member
// constraint; a manual entry here can be created already-closed.
shiftsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const data = parseBody(createSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')
    await assertOwnership(data.workspaceId, { crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId })

    const startTime = new Date(data.startTime)
    const endTime = data.endTime ? new Date(data.endTime) : null
    if (endTime && endTime <= startTime) throw new ApiError(400, 'endTime must be after startTime')
    const breakMinutes = data.breakMinutes ?? 0
    const outdoorHighRisk = data.outdoorHighRisk ?? false
    const allowanceTag = data.allowanceTag || 'NONE'

    const shift = await prisma.opsShiftRecord.create({
      data: {
        workspaceId: data.workspaceId, crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId,
        shiftDate: new Date(data.shiftDate), startTime, endTime, breakMinutes, allowanceTag, outdoorHighRisk,
        notes: data.notes, totalHours: totalHoursFor(startTime, endTime, breakMinutes),
      },
    })
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.shift.created', entityType: 'OpsShiftRecord', entityId: shift.id })
    if (endTime) await reconcileShiftAlerts(data.workspaceId, shift.id, shift)

    res.status(201).json({ shift })
  })
)

const idParamsSchema = z.object({ id: idField })

const updateSchema = z.object({
  workspaceId: workspaceIdField,
  jobSiteId: idField.optional(),
  endTime: z.string().datetime().optional(),
  breakMinutes: z.number().int().min(0).max(1440).optional(),
  allowanceTag: z.string().trim().max(64).optional(),
  outdoorHighRisk: z.boolean().optional(),
  heatCheckCompleted: z.boolean().optional(),
  fatigueConcern: z.boolean().optional(),
  corRelated: z.boolean().optional(),
  reviewed: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
})
type _UpdateShiftConforms = Assert<Extends<z.infer<typeof updateSchema>, OpsUpdateShiftRequest>>

// PUT /api/ops/shifts/:id — correction/annotation. Deliberately does NOT default
// endTime to now() when it's simply absent from the body: an earlier version of
// this handler did exactly that, which meant editing e.g. just `notes` on a
// still-open shift silently closed it. endTime only changes when the caller
// explicitly sends one.
shiftsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const data = parseBody(updateSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')

    const existing = await prisma.opsShiftRecord.findFirst({ where: { id, workspaceId: data.workspaceId } })
    if (!existing) throw new ApiError(404, 'Shift not found')
    if (data.jobSiteId) await assertOwnership(data.workspaceId, { jobSiteId: data.jobSiteId })

    const endTime = 'endTime' in data && data.endTime !== undefined ? new Date(data.endTime) : existing.endTime
    if (endTime && endTime <= existing.startTime) throw new ApiError(400, 'endTime must be after startTime')
    const breakMinutes = data.breakMinutes ?? existing.breakMinutes

    const updated = await prisma.opsShiftRecord.update({
      where: { id },
      data: {
        ...(data.jobSiteId ? { jobSiteId: data.jobSiteId } : {}),
        ...(data.endTime !== undefined ? { endTime } : {}),
        ...(data.breakMinutes !== undefined ? { breakMinutes } : {}),
        ...(data.allowanceTag !== undefined ? { allowanceTag: data.allowanceTag || 'NONE' } : {}),
        ...(data.outdoorHighRisk !== undefined ? { outdoorHighRisk: data.outdoorHighRisk } : {}),
        ...(data.heatCheckCompleted !== undefined ? { heatCheckCompleted: data.heatCheckCompleted } : {}),
        ...(data.fatigueConcern !== undefined ? { fatigueConcern: data.fatigueConcern } : {}),
        ...(data.corRelated !== undefined ? { corRelated: data.corRelated } : {}),
        ...(data.reviewed !== undefined ? { reviewed: data.reviewed } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        totalHours: totalHoursFor(existing.startTime, endTime, breakMinutes),
      },
    })
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.shift.updated', entityType: 'OpsShiftRecord', entityId: id })
    await reconcileShiftAlerts(data.workspaceId, id, updated)

    res.json({ shift: updated })
  })
)

const deleteQuerySchema = z.object({ workspaceId: workspaceIdField })

// DELETE /api/ops/shifts/:id — remove an erroneous manual entry. Related
// OpsAlert rows are preserved with shiftRecordId cleared (onDelete: SetNull in
// the schema), not deleted, so a review history isn't silently lost.
shiftsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(deleteQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const existing = await prisma.opsShiftRecord.findFirst({ where: { id, workspaceId } })
    if (!existing) throw new ApiError(404, 'Shift not found')
    await prisma.opsShiftRecord.delete({ where: { id } })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.shift.deleted', entityType: 'OpsShiftRecord', entityId: id })

    res.json({ deleted: true, id })
  })
)
