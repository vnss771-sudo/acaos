import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField } from '../../lib/validate.js'
import { clampPagination, auditOps } from './utils.js'

// Compliance alerts: the OPEN/REVIEWED worklist a supervisor actions. The rows
// themselves are never authored here — reconcileShiftAlerts() in utils.ts owns
// creating, updating and clearing them as shifts are created/edited/closed (see
// shifts.ts and clock.ts). This router only reads that worklist and records a
// human review of a row, so the only mutation is the review stamp ('ops:manage',
// admin+); listing and counts are member-level.
export const alertsRouter = Router()
alertsRouter.use(requireAuth)
alertsRouter.use(requireVerifiedForMutation)

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  status: z.enum(['OPEN', 'REVIEWED']).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

// GET /api/ops/alerts — the alert worklist, filterable and paginated. The order
// is the triage order: OPEN before REVIEWED (status asc), then most severe first
// (severity desc — the enum is declared LOW..CRITICAL, so desc is CRITICAL
// first), then newest first, so the top of page 1 is always what to action next.
alertsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')
    const { page, limit, skip } = clampPagination(q.page, q.limit)

    const where = {
      workspaceId: q.workspaceId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
    }

    const [alerts, total] = await Promise.all([
      prisma.opsAlert.findMany({ where, orderBy: [{ status: 'asc' }, { severity: 'desc' }, { createdAt: 'desc' }], skip, take: limit }),
      prisma.opsAlert.count({ where }),
    ])

    res.json({ alerts, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

const countsQuerySchema = z.object({ workspaceId: workspaceIdField })

// GET /api/ops/alerts/counts — badge counts for the ops nav, so the UI doesn't
// have to page the whole list to render a number. openHigh spans BOTH urgent
// tiers (HIGH and CRITICAL): the scale has four levels, and an alert that
// escalated past HIGH must not drop out of the urgent badge.
alertsRouter.get(
  '/counts',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(countsQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const [open, reviewed, openHigh] = await Promise.all([
      prisma.opsAlert.count({ where: { workspaceId, status: 'OPEN' } }),
      prisma.opsAlert.count({ where: { workspaceId, status: 'REVIEWED' } }),
      prisma.opsAlert.count({ where: { workspaceId, status: 'OPEN', severity: { in: ['HIGH', 'CRITICAL'] } } }),
    ])

    res.json({ open, reviewed, openHigh })
  })
)

const idParamsSchema = z.object({ id: idField })

const reviewSchema = z.object({ workspaceId: workspaceIdField })

// POST /api/ops/alerts/:id/review — mark an alert reviewed. reviewedBy stores the
// reviewer's USER ID, never their display name: a name is mutable and isn't a
// stable reference, and every other actor column in this codebase (AuditEvent
// .actorUserId, auditOps's actorUserId) stores an id.
//
// Idempotent on an already-REVIEWED alert: it returns the existing row untouched
// rather than re-stamping reviewedBy/reviewedAt. A second click (or two
// supervisors opening the same worklist) must not overwrite who actually
// reviewed it first, which is the whole point of keeping the attribution.
alertsRouter.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseBody(reviewSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const existing = await prisma.opsAlert.findFirst({ where: { id, workspaceId } })
    if (!existing) throw new ApiError(404, 'Alert not found')
    if (existing.status === 'REVIEWED') {
      res.json({ alert: existing })
      return
    }

    const alert = await prisma.opsAlert.update({
      where: { id },
      data: { status: 'REVIEWED', reviewedBy: user.id, reviewedAt: new Date() },
    })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.alert.reviewed', entityType: 'OpsAlert', entityId: id })

    res.json({ alert })
  })
)
