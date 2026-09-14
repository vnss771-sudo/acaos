import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { parseQuery, parseBody, workspaceIdField, idField } from '../../lib/validate.js'
import { assertOwnership, reconcileShiftAlerts, totalHoursFor, utcDayStart, auditOps, geofenceViolationMeters, assertCanActAsCrewMember } from './utils.js'
import type { Assert, Extends, OpsClockInRequest, OpsClockOutRequest } from '@acaos/shared'

// Crew self-service clock in/out. Deliberately membership-level, not
// 'ops:manage': a crew member clocking themselves in is not an admin action —
// but "themselves" is enforced by assertCanActAsCrewMember, not just assumed:
// a caller can only clock in/out a crewMemberId linked (OpsCrewMember.userId)
// to their own account, unless they hold 'ops:manage' (a supervisor entering
// it on someone's behalf, which is then itself audited as such). Ownership of
// crewMemberId/jobSiteId (that they belong to the caller's workspace) is still
// enforced on every request — membership alone doesn't prove the IDs in the
// body are real, workspace-owned resources.
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
type _ClockInConforms = Assert<Extends<z.infer<typeof clockInSchema>, OpsClockInRequest>>

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
    const supervisorOverride = await assertCanActAsCrewMember(data.workspaceId, data.crewMemberId, user.id)

    const jobSite = await prisma.opsJobSite.findFirst({
      where: { id: data.jobSiteId, workspaceId: data.workspaceId },
      select: { lat: true, lng: true, radiusMeters: true },
    })
    const overMeters = geofenceViolationMeters(jobSite, data.lat, data.lng)
    if (overMeters !== null) {
      throw new ApiError(400, `Clock-in location is ${overMeters}m outside the job site's geofence`)
    }

    const now = new Date()
    try {
      const shift = await prisma.opsShiftRecord.create({
        data: {
          workspaceId: data.workspaceId, crewMemberId: data.crewMemberId, jobSiteId: data.jobSiteId,
          shiftDate: utcDayStart(now), startTime: now, endTime: null,
          clockInLat: data.lat, clockInLng: data.lng,
        },
      })
      auditOps({
        workspaceId: data.workspaceId, actorUserId: user.id, type: supervisorOverride ? 'ops.clock.in.supervisor' : 'ops.clock.in',
        entityType: 'OpsShiftRecord', entityId: shift.id,
      })
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
type _ClockOutConforms = Assert<Extends<z.infer<typeof clockOutSchema>, OpsClockOutRequest>>

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
    const supervisorOverride = await assertCanActAsCrewMember(data.workspaceId, data.crewMemberId, user.id)

    const open = await prisma.opsShiftRecord.findFirst({
      where: { workspaceId: data.workspaceId, crewMemberId: data.crewMemberId, endTime: null },
      include: { jobSite: { select: { lat: true, lng: true, radiusMeters: true } } },
    })
    if (!open) throw new ApiError(404, 'No open shift for this crew member')
    const overMeters = geofenceViolationMeters(open.jobSite, data.lat, data.lng)
    if (overMeters !== null) {
      throw new ApiError(400, `Clock-out location is ${overMeters}m outside the job site's geofence`)
    }

    const endTime = new Date()
    const updated = await prisma.opsShiftRecord.update({
      where: { id: open.id },
      data: {
        endTime, clockOutLat: data.lat, clockOutLng: data.lng,
        totalHours: totalHoursFor(open.startTime, endTime, open.breakMinutes),
      },
    })
    auditOps({
      workspaceId: data.workspaceId, actorUserId: user.id, type: supervisorOverride ? 'ops.clock.out.supervisor' : 'ops.clock.out',
      entityType: 'OpsShiftRecord', entityId: open.id,
    })
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
      include: {
        crewMember: { select: { id: true, fullName: true, employeeCode: true } },
        jobSite: { select: { id: true, siteName: true, jobCode: true } },
      },
    })
    res.json({ clockedIn: Boolean(shift), shift: shift ?? null })
  })
)
