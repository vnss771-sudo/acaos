// Shared helpers for the Ops module's route handlers. Every ops/*.ts file uses
// these instead of reinventing pagination, ownership checks, or alert
// reconciliation per-file — see docs/CONFIGURATION.md and the route files
// themselves for the endpoints that call them.

import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { recordAudit } from '../../lib/audit.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import type { Prisma } from '@prisma/client'

// ── Pagination ───────────────────────────────────────────────────────────────
// Matches the inline Math.max/Math.min clamp already used by leads.ts and every
// other paginated list route: page >= 1, 1 <= limit <= 100.

export function clampPagination(page: unknown, limit: unknown): { page: number; limit: number; skip: number } {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(100, Math.max(1, Number(limit) || 25))
  return { page: p, limit: l, skip: (p - 1) * l }
}

// ── Shift math ───────────────────────────────────────────────────────────────
// Shared by shifts.ts (manual entry/edit) and clock.ts (live clock-out) so a
// shift's totalHours is computed identically regardless of how it was closed.
export function totalHoursFor(startTime: Date, endTime: Date | null, breakMinutes: number): number {
  if (!endTime) return 0
  const rawHours = (endTime.getTime() - startTime.getTime()) / 3_600_000 - breakMinutes / 60
  return Math.max(0, Math.round(rawHours * 100) / 100)
}

// UTC day start for shiftDate bucketing — matches the UTC-day convention already
// used for send caps and campaign-stats bucketing elsewhere in the codebase,
// rather than the server process's local timezone.
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

// Monday-start UTC week containing `d`, as [start, end) — shared by admin.ts's
// dashboard and roster.ts's summary so "this week" means the same thing in both.
export function utcWeekRange(d: Date): { start: Date; end: Date } {
  const day = utcDayStart(d)
  // getUTCDay(): 0=Sun..6=Sat. Days-since-Monday: Sun→6, Mon→0, Tue→1, …
  const daysSinceMonday = (day.getUTCDay() + 6) % 7
  const start = new Date(day.getTime() - daysSinceMonday * 86_400_000)
  const end = new Date(start.getTime() + 7 * 86_400_000)
  return { start, end }
}

// ── Ownership ────────────────────────────────────────────────────────────────
// Shift/roster mutations accept a crewMemberId and/or jobSiteId in the body.
// Without this check, a caller could reference another workspace's crew member
// or job site — the resource-belongs-to-the-caller's-workspace half of tenant
// isolation that a plain assertWorkspacePermission(workspaceId) can't catch,
// since it only proves the CALLER is in that workspace, not that the RESOURCE is.
export async function assertOwnership(
  workspaceId: string,
  ids: { crewMemberId?: string; jobSiteId?: string },
): Promise<void> {
  const checks: Promise<unknown>[] = []
  if (ids.crewMemberId) {
    checks.push(
      prisma.opsCrewMember.findFirst({ where: { id: ids.crewMemberId, workspaceId }, select: { id: true } })
        .then((r) => { if (!r) throw new ApiError(404, 'Crew member not found') }),
    )
  }
  if (ids.jobSiteId) {
    checks.push(
      prisma.opsJobSite.findFirst({ where: { id: ids.jobSiteId, workspaceId }, select: { id: true } })
        .then((r) => { if (!r) throw new ApiError(404, 'Job site not found') }),
    )
  }
  await Promise.all(checks)
}

// Clock in/out is deliberately membership-level (see clock.ts), so "any
// workspace member" is not enough on its own — this closes the gap: a caller
// may only clock in/out a crewMemberId linked (OpsCrewMember.userId) to their
// OWN account. A crew member with no login (userId null) has no self-service
// identity to match, so their clock actions always require the supervisor
// override below. Returns true when the call was authorized via that
// override (not as the crew member themselves) — callers use this to record
// a distinguishable, honestly-labeled audit event type. Throws 403 if
// neither the identity match nor the override applies.
export async function assertCanActAsCrewMember(
  workspaceId: string,
  crewMemberId: string,
  actorUserId: string,
): Promise<boolean> {
  const crewMember = await prisma.opsCrewMember.findFirst({ where: { id: crewMemberId, workspaceId }, select: { userId: true } })
  if (crewMember?.userId && crewMember.userId === actorUserId) return false
  await assertWorkspacePermission(actorUserId, workspaceId, 'ops:manage')
  return true
}

// ── Geofencing ───────────────────────────────────────────────────────────────
// Great-circle distance in meters (haversine) — accurate enough at the scale
// of a job site radius; no need for an ellipsoidal model here.
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Returns how many meters over the job site's geofence a clock-in/out
// location is, or null if the clock-in is within radius (or either side
// lacks the data to check — a site with no lat/lng/radiusMeters configured,
// or a caller that didn't send coordinates, is advisory-only by design: many
// sites won't have GPS configured, and this must not block them).
export function geofenceViolationMeters(
  jobSite: { lat: number | null; lng: number | null; radiusMeters: number | null } | null | undefined,
  lat: number | undefined,
  lng: number | undefined,
): number | null {
  if (!jobSite || jobSite.lat == null || jobSite.lng == null || jobSite.radiusMeters == null) return null
  if (lat == null || lng == null) return null
  const dist = distanceMeters(lat, lng, jobSite.lat, jobSite.lng)
  if (dist <= jobSite.radiusMeters) return null
  return Math.round(dist - jobSite.radiusMeters)
}

// ── Alert reconciliation ─────────────────────────────────────────────────────
// Recomputes which compliance alerts a shift SHOULD have and reconciles the
// OpsAlert rows to match — called after clock-out and after a shift edit that
// changes any of the flagged fields. Upsert-based (never delete-then-recreate):
// a delete-then-recreate would lose reviewedBy/reviewedAt on an alert a reviewer
// already actioned, and race a concurrent review (the review's UPDATE landing
// between this function's DELETE and its INSERT would be silently undone).
// Each alert type gets a stable, deterministic key so "should this alert exist"
// is an idempotent upsert, and "should it no longer exist" only deletes an alert
// that is still OPEN — a REVIEWED alert is historical record and is left alone.

type AlertSpec = { alertType: 'MISSING_HEAT_CHECK' | 'FATIGUE_THRESHOLD' | 'MISSING_ALLOWANCE'; title: string; message: string; severity: 'MEDIUM' | 'HIGH' | 'CRITICAL' }

function wantedAlerts(shift: {
  outdoorHighRisk: boolean
  heatCheckCompleted: boolean
  fatigueConcern: boolean
  allowanceTag: string
}): AlertSpec[] {
  const alerts: AlertSpec[] = []
  if (shift.outdoorHighRisk && !shift.heatCheckCompleted) {
    alerts.push({ alertType: 'MISSING_HEAT_CHECK', title: 'Heat check not completed', message: 'This outdoor high-risk shift is missing its required heat-safety check.', severity: 'HIGH' })
  }
  if (shift.fatigueConcern) {
    alerts.push({ alertType: 'FATIGUE_THRESHOLD', title: 'Fatigue threshold flagged', message: 'This shift was flagged for a fatigue concern.', severity: 'HIGH' })
  }
  if (shift.outdoorHighRisk && shift.allowanceTag === 'NONE') {
    alerts.push({ alertType: 'MISSING_ALLOWANCE', title: 'Allowance not recorded', message: 'This outdoor high-risk shift has no allowance tag recorded.', severity: 'MEDIUM' })
  }
  return alerts
}

export async function reconcileShiftAlerts(
  workspaceId: string,
  shiftRecordId: string,
  shift: { outdoorHighRisk: boolean; heatCheckCompleted: boolean; fatigueConcern: boolean; allowanceTag: string },
): Promise<void> {
  const wanted = wantedAlerts(shift)
  const wantedTypes = new Set(wanted.map((a) => a.alertType))

  const existing = await prisma.opsAlert.findMany({
    where: { workspaceId, shiftRecordId, status: 'OPEN' },
    select: { id: true, alertType: true },
  })
  const existingByType = new Map(existing.map((a) => [a.alertType, a.id]))

  await prisma.$transaction([
    // No-longer-warranted OPEN alerts are cleared (e.g. the heat check was
    // subsequently completed). REVIEWED alerts are never touched here.
    prisma.opsAlert.deleteMany({
      where: { workspaceId, shiftRecordId, status: 'OPEN', alertType: { notIn: [...wantedTypes] } },
    }),
    ...wanted.map((spec) =>
      existingByType.has(spec.alertType)
        ? prisma.opsAlert.update({ where: { id: existingByType.get(spec.alertType)! }, data: { title: spec.title, message: spec.message, severity: spec.severity } })
        : prisma.opsAlert.create({ data: { workspaceId, shiftRecordId, ...spec } }),
    ),
  ])
}

// Fire-and-forget audit helper mirroring every other route's `void recordAudit(...)`
// call — kept here only so ops/*.ts files share one import instead of each
// reaching into lib/audit.ts with slightly different argument shapes.
export function auditOps(input: { workspaceId: string; actorUserId: string; type: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }): void {
  void recordAudit(input)
}

export type Db = typeof prisma
export type { Prisma }
