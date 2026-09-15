import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { parseQuery, parseParams, workspaceIdField, idField } from '../../lib/validate.js'
import { utcDayStart } from './utils.js'

// Fatigue risk: a READ-ONLY report computed from OpsShiftRecord history over a
// rolling 7-day window. Nothing in this file writes to the database — in
// particular it deliberately does not raise or clear OpsAlert rows. Alert
// lifecycle belongs to reconcileShiftAlerts() in utils.ts, driven by the
// `fatigueConcern` boolean a human sets on a shift (shifts.ts PUT); that human
// judgement and this computed score are separate concerns, and having a GET
// silently author compliance records would make the report's own read path a
// hidden mutation. Reading is member-level throughout.
export const fatigueRouter = Router()
fatigueRouter.use(requireAuth)
fatigueRouter.use(requireVerifiedForMutation)

export type FatigueRisk = {
  crewMemberId: string
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  riskScore: number
  factors: string[]
  totalHours7d: number
  avgHoursPerDay: number
  consecutiveDays: number
  // True when the streak fills the entire lookback window (CONSECUTIVE_LOOKBACK_DAYS)
  // — the real streak may be longer than `consecutiveDays` reports. Callers should
  // render e.g. "30+ consecutive days" rather than an exact count in this case.
  consecutiveDaysCapped: boolean
  lastShiftDate: string | null
  recommendation: string
}

// ── Scoring model ────────────────────────────────────────────────────────────
// Two independent contributors, each capped so neither alone can saturate the
// score: volume (hours worked past a healthy weekly baseline) and continuity
// (days worked back-to-back without a rest day). Every factor string below
// corresponds to a contributor that actually scored, so `factors` always
// explains `riskScore` rather than drifting from it.

const WINDOW_DAYS = 7
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000
const HEALTHY_WEEKLY_HOURS = 40
const POINTS_PER_OVERTIME_HOUR = 2
const MAX_OVERTIME_POINTS = 50
// A 4th consecutive day is the first one that scores; each further day adds the
// same amount again, so a full unbroken week is weighted heaviest.
const CONSECUTIVE_DAYS_THRESHOLD = 4
const POINTS_PER_CONSECUTIVE_DAY = 8
const MAX_CONSECUTIVE_POINTS = 40

// Consecutive-day counting looks back further than the 7-day hours/overtime
// window — a 7-day streak and a 30-day streak must not report identically. This
// is still a cheap, single-query per-crew-member date-range scan (same shape as
// the 7-day query, just a wider `since`), so widening it costs nothing extra in
// query complexity. It's still a bound, not infinity: a streak that fills the
// entire lookback is reported as "N+" (see FatigueRisk.consecutiveDaysCapped)
// rather than implying the streak is known to stop exactly there.
const CONSECUTIVE_LOOKBACK_DAYS = 30
const CONSECUTIVE_LOOKBACK_MS = CONSECUTIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Longest unbroken run of calendar days (UTC) with at least one shift, counted
// backwards from the most recent day worked. Multiple shifts on one day are one
// day — a double-header is a long day, not two consecutive days, and counting it
// twice would overstate continuity.
function trailingConsecutiveDays(shifts: { startTime: Date }[]): number {
  const days = [...new Set(shifts.map((s) => utcDayStart(s.startTime).getTime()))].sort((a, b) => b - a)
  if (days.length === 0) return 0
  const dayMs = 24 * 60 * 60 * 1000
  let run = 1
  for (let i = 1; i < days.length; i += 1) {
    if (days[i - 1]! - days[i]! !== dayMs) break
    run += 1
  }
  return run
}

function levelFor(score: number): FatigueRisk['riskLevel'] {
  if (score >= 60) return 'CRITICAL'
  if (score >= 35) return 'HIGH'
  if (score >= 15) return 'MEDIUM'
  return 'LOW'
}

function recommendationFor(level: FatigueRisk['riskLevel'], hasShifts: boolean): string {
  if (!hasShifts) return 'No recent shift history in the last 7 days; no fatigue risk can be assessed from shift data.'
  switch (level) {
    case 'CRITICAL':
      return 'Mandatory rest required. Do not schedule until fatigue risk is mitigated.'
    case 'HIGH':
      return 'Limit to a single shift per day and enforce the minimum rest period between shifts before the next roster.'
    case 'MEDIUM':
      return 'Monitor this crew member and avoid rostering overtime or back-to-back shifts this week.'
    default:
      return 'No elevated fatigue risk from recent shift history.'
  }
}

// Pure: takes the crew member's shifts already narrowed to the (wider,
// CONSECUTIVE_LOOKBACK_DAYS) window, so the per-crew-member endpoint and the
// workspace summary compute identical numbers from one implementation (the
// summary loads every crew member's shifts in a single query and buckets them
// here, rather than querying per person). The 7-day hours/overtime figures are
// derived from a narrower slice of the same list, not a second query.
function computeFatigue(crewMemberId: string, shifts: { shiftDate: Date; startTime: Date; totalHours: number }[]): FatigueRisk {
  if (shifts.length === 0) {
    return {
      crewMemberId, riskLevel: 'LOW', riskScore: 0, factors: [],
      totalHours7d: 0, avgHoursPerDay: 0, consecutiveDays: 0, consecutiveDaysCapped: false, lastShiftDate: null,
      recommendation: recommendationFor('LOW', false),
    }
  }

  const hoursSince = new Date(Date.now() - WINDOW_MS)
  const shifts7d = shifts.filter((s) => s.startTime >= hoursSince)
  const totalHours7d = round2(shifts7d.reduce((sum, s) => sum + s.totalHours, 0))
  const avgHoursPerDay = round2(totalHours7d / WINDOW_DAYS)
  const consecutiveDays = trailingConsecutiveDays(shifts)
  // -1 day of slack: the query's `since` cutoff is computed a few milliseconds
  // AFTER the oldest shift in a genuinely full-window streak was seeded/recorded,
  // so a streak that exactly fills the window can lose its oldest day to that
  // skew and come back one short. Treating N-1 as "capped" avoids reporting a
  // false, overly-precise count right at the boundary.
  const consecutiveDaysCapped = consecutiveDays >= CONSECUTIVE_LOOKBACK_DAYS - 1
  // Shifts arrive ordered by startTime ascending, so the last one is the most recent.
  const lastShift = shifts[shifts.length - 1]!

  const factors: string[] = []
  let riskScore = 0

  const overtimeHours = Math.max(0, totalHours7d - HEALTHY_WEEKLY_HOURS)
  if (overtimeHours > 0) {
    riskScore += Math.min(MAX_OVERTIME_POINTS, overtimeHours * POINTS_PER_OVERTIME_HOUR)
    factors.push(`${totalHours7d} hours in the last 7 days`)
  }
  if (consecutiveDays >= CONSECUTIVE_DAYS_THRESHOLD) {
    const scoringDays = consecutiveDays - (CONSECUTIVE_DAYS_THRESHOLD - 1)
    riskScore += Math.min(MAX_CONSECUTIVE_POINTS, scoringDays * POINTS_PER_CONSECUTIVE_DAY)
    factors.push(`${consecutiveDays}${consecutiveDaysCapped ? '+' : ''} consecutive days worked`)
  }

  riskScore = Math.min(100, Math.max(0, Math.round(riskScore)))
  const riskLevel = levelFor(riskScore)

  return {
    crewMemberId, riskLevel, riskScore, factors, totalHours7d, avgHoursPerDay, consecutiveDays, consecutiveDaysCapped,
    lastShiftDate: lastShift.shiftDate.toISOString(),
    recommendation: recommendationFor(riskLevel, true),
  }
}

const shiftSelect = { crewMemberId: true, shiftDate: true, startTime: true, totalHours: true } as const

const workspaceQuerySchema = z.object({ workspaceId: workspaceIdField })

// GET /api/ops/fatigue — workspace-wide summary across ACTIVE crew members.
// Inactive crew are excluded: they aren't rosterable, so their trailing history
// would only pad the buckets a supervisor triages. Reports come back highest
// risk first so the people to act on are at the top of the list.
fatigueRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const since = new Date(Date.now() - CONSECUTIVE_LOOKBACK_MS)
    const crew = await prisma.opsCrewMember.findMany({ where: { workspaceId, isActive: true }, select: { id: true } })
    const crewIds: string[] = crew.map((c: { id: string }) => c.id)

    // One query for every crew member's window, bucketed in memory — a per-crew
    // member query would be an N+1 over the whole active roster.
    const shifts = crewIds.length
      ? await prisma.opsShiftRecord.findMany({
          where: { workspaceId, crewMemberId: { in: crewIds }, startTime: { gte: since } },
          orderBy: { startTime: 'asc' },
          select: shiftSelect,
        })
      : []
    const byCrewMember = new Map<string, typeof shifts>()
    for (const shift of shifts) {
      const bucket = byCrewMember.get(shift.crewMemberId)
      if (bucket) bucket.push(shift)
      else byCrewMember.set(shift.crewMemberId, [shift])
    }

    const reports: FatigueRisk[] = crewIds
      .map((id: string) => computeFatigue(id, byCrewMember.get(id) ?? []))
      .sort((a: FatigueRisk, b: FatigueRisk) => b.riskScore - a.riskScore)

    const summary = {
      critical: reports.filter((r: FatigueRisk) => r.riskLevel === 'CRITICAL').length,
      high: reports.filter((r: FatigueRisk) => r.riskLevel === 'HIGH').length,
      medium: reports.filter((r: FatigueRisk) => r.riskLevel === 'MEDIUM').length,
      low: reports.filter((r: FatigueRisk) => r.riskLevel === 'LOW').length,
    }

    res.json({ summary, reports })
  })
)

const crewMemberParamsSchema = z.object({ crewMemberId: idField })

// GET /api/ops/fatigue/:crewMemberId — one crew member's report. Existence is
// checked against the caller's workspace first, so a crew member from another
// tenant 404s instead of returning an empty-history "LOW risk" report that would
// confirm (or deny) that the id exists elsewhere.
fatigueRouter.get(
  '/:crewMemberId',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { crewMemberId } = parseParams(crewMemberParamsSchema, req)
    const { workspaceId } = parseQuery(workspaceQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')

    const crewMember = await prisma.opsCrewMember.findFirst({ where: { id: crewMemberId, workspaceId }, select: { id: true } })
    if (!crewMember) throw new ApiError(404, 'Crew member not found')

    const since = new Date(Date.now() - CONSECUTIVE_LOOKBACK_MS)
    const shifts = await prisma.opsShiftRecord.findMany({
      where: { workspaceId, crewMemberId, startTime: { gte: since } },
      orderBy: { startTime: 'asc' },
      select: shiftSelect,
    })

    res.json({ fatigue: computeFatigue(crewMemberId, shifts) })
  })
)
