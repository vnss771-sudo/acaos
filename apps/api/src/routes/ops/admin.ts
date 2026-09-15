import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { parseQuery, workspaceIdField } from '../../lib/validate.js'
import { utcWeekRange } from './utils.js'

// Ops dashboard: one aggregated read for the overview screen. Member-readable,
// like every other dashboard in the app. Every list here carries an explicit
// `take` cap — an admin overview must never become an unbounded query as a
// workspace's Ops history grows; it summarizes, it doesn't paginate.
export const adminRouter = Router()
adminRouter.use(requireAuth)
adminRouter.use(requireVerifiedForMutation)

const overviewQuerySchema = z.object({ workspaceId: workspaceIdField })

const crewSelect = { id: true, fullName: true, employeeCode: true } as const
const jobSiteSelect = { id: true, siteName: true, jobCode: true } as const

adminRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(overviewQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const { start: weekStart, end: weekEnd } = utcWeekRange(new Date())
    const weekWhere = { workspaceId, shiftDate: { gte: weekStart, lt: weekEnd } }

    const [
      activeCrewCount,
      jobSiteCount,
      openAlertCount,
      reviewedAlertCount,
      weekHours,
      flaggedShiftsCount,
      missingHeatChecksCount,
      fatigueAlertsCount,
      clockedInCrew,
      recentShifts,
      openAlerts,
      upcomingRoster,
    ] = await Promise.all([
      prisma.opsCrewMember.count({ where: { workspaceId, isActive: true } }),
      prisma.opsJobSite.count({ where: { workspaceId, status: { not: 'ARCHIVED' } } }),
      prisma.opsAlert.count({ where: { workspaceId, status: 'OPEN' } }),
      prisma.opsAlert.count({ where: { workspaceId, status: 'REVIEWED' } }),
      prisma.opsShiftRecord.aggregate({ where: weekWhere, _sum: { totalHours: true } }),
      prisma.opsShiftRecord.count({ where: { ...weekWhere, OR: [{ fatigueConcern: true }, { corRelated: true }] } }),
      prisma.opsShiftRecord.count({ where: { ...weekWhere, outdoorHighRisk: true, heatCheckCompleted: false } }),
      prisma.opsAlert.count({ where: { workspaceId, status: 'OPEN', alertType: 'FATIGUE_THRESHOLD' } }),
      prisma.opsShiftRecord.findMany({
        where: { workspaceId, endTime: null },
        orderBy: { startTime: 'asc' },
        take: 200,
        select: { id: true, startTime: true, crewMember: { select: crewSelect }, jobSite: { select: jobSiteSelect } },
      }),
      prisma.opsShiftRecord.findMany({
        where: { workspaceId },
        orderBy: [{ shiftDate: 'desc' }, { startTime: 'desc' }],
        take: 6,
        select: { id: true, shiftDate: true, startTime: true, endTime: true, totalHours: true, crewMember: { select: crewSelect }, jobSite: { select: jobSiteSelect } },
      }),
      prisma.opsAlert.findMany({
        where: { workspaceId, status: 'OPEN' },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        take: 5,
      }),
      prisma.opsRosterEntry.findMany({
        where: { workspaceId, status: 'PUBLISHED', rosterDate: { gte: weekStart } },
        orderBy: [{ rosterDate: 'asc' }, { startTime: 'asc' }],
        take: 8,
        select: { id: true, rosterDate: true, startTime: true, endTime: true, shiftType: true, crewMember: { select: crewSelect }, jobSite: { select: jobSiteSelect } },
      }),
    ])

    res.json({
      overview: {
        activeCrewCount,
        jobSiteCount,
        openAlertCount,
        reviewedAlertCount,
        thisWeekShiftHours: weekHours._sum.totalHours ?? 0,
        flaggedShiftsCount,
        missingHeatChecksCount,
        fatigueAlertsCount,
        clockedInCrew,
        recentShifts,
        openAlerts,
        upcomingRoster,
      },
    })
  })
)
