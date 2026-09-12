import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { parseQuery, parseBody, workspaceIdField, idField } from '../../lib/validate.js'
import { assertOwnership, reconcileShiftAlerts, totalHoursFor, utcDayStart, auditOps } from './utils.js'

// Crew self-service clock in/out. Deliberately membership-level, not
// 'ops:manage': a crew member clocking themselves in is not an admin action.
// Ownership of crewMemberId/jobSiteId (that they belong to the caller's
// workspace) is still enforced on every request — membership alone doesn't
// prove the IDs in the body are real, workspace-owned resources.
export const clockRouter = Router()
clockRouter.use(requireAuth)
clockRouter.use(requireVerifiedForMutation)

const geoField = z.number().min(-90).max(90).optional()
const lngField = z.number().min(-180).max(180).optional()

const clockInSchema = z.object({
  workspaceId: workspaceIdField,
  crewMemberId: idField,
  jobSiteId: idField,
  lat: geoField,
  lng: lngField,
})

// POST /api/ops/clock/in — opens a new shift. The one-open-shift-per-crew-member
// invariant is enforced by a partial unique index in the database (see the
// OpsShiftRecord.endTime migration comment in schema.prisma), NOT by a
// check-then-create in application code — a SELECT-then-INSERT here would be a
// race between two concurrent clock-ins for the same crew member. This handler
// just attempts the insert and turns the resulting P2002 into a clean 409.
clockRouter.post(
  '/in',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const data = parseBody(clockInSchema, req)
    if (!(await userBelongsToWorkspace(user.id, data.workspaceId))) throw new ApiError(403, 'Access denied')
    await assertOwnership(data.workspaceId, { crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId })

    const now = new Date()
    try {
      const shift = await prisma.opsShiftRecord.create({
        data: {
          workspaceId: data.workspaceId, crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId,
          shiftDate: utcDayStart(now), startTime: now, endTime: null,
          clockInLat: data.lat, clockInLng: data.lng,
        },
      })
      auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.clock.in', entityType: 'OpsShiftRecord', entityId: shift.id })
      res.status(201).json({ shift })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ApiError(409, 'This crew member already has an open shift — clock out first')
      }
      throw err
    }
  })
)

const clockOutSchema = z.object({
  workspaceId: workspaceIdField,
  crewMemberId: idField,
  lat: geoField,
  lng: lngField,
})

// POST /api/ops/clock/out — closes the crew member's open shift, if any. Scoped
// by the EXACT crewMemberId given (never "any open shift in the workspace") —
// an earlier version of this class of query returned whichever crew member's
// shift happened to match first, showing the wrong person's clock state.
clockRouter.post(
  '/out',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const data = parseBody(clockOutSchema, req)
    if (!(await userBelongsToWorkspace(user.id, data.workspaceId))) throw new ApiError(403, 'Access denied')
    await assertOwnership(data.workspaceId, { crewMemberId: data.crewMemberId })

    const open = await prisma.opsShiftRecord.findFirst({
      where: { workspaceId: data.workspaceId, crewMemberId: data.crewMemberId, endTime: null },
    })
    if (!open) throw new ApiError(404, 'No open shift for this crew member')

    const endTime = new Date()
    const updated = await prisma.opsShiftRecord.update({
      where: { id: open.id },
      data: {
        endTime, clockOutLat: data.lat, clockOutLng: data.lng,
        totalHours: totalHoursFor(open.startTime, endTime, open.breakMinutes),
      },
    })
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.clock.out', entityType: 'OpsShiftRecord', entityId: open.id })
    await reconcileShiftAlerts(data.workspaceId, open.id, updated)

    res.json({ shift: updated })
  })
)

const statusQuerySchema = z.object({ workspaceId: workspaceIdField, crewMemberId: idField })

// GET /api/ops/clock/status?workspaceId=&crewMemberId= — clock state for the
// EXACT crew member requested, never a workspace-wide "any open shift" lookup.
clockRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(statusQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')
    await assertOwnership(q.workspaceId, { crewMemberId: q.crewMemberId })

    const shift = await prisma.opsShiftRecord.findFirst({
      where: { workspaceId: q.workspaceId, crewMemberId: q.crewMemberId, endTime: null },
    })
    res.json({ clockedIn: Boolean(shift), shift: shift ?? null })
  })
)
