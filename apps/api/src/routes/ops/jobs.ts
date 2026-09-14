import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField, nonEmptyString } from '../../lib/validate.js'
import { clampPagination, auditOps } from './utils.js'
import type { Assert, Extends, OpsCreateJobSiteRequest, OpsUpdateJobSiteRequest } from '@acaos/shared'

// Job sites: the physical construction/field sites shifts and rosters are worked
// against (OpsShiftRecord.jobSiteId / OpsRosterEntry.jobSiteId). Unrelated to the
// top-level routes/jobs.ts, which is about background queue jobs. Reading is
// member-level; every mutation is 'ops:manage' (admin+). A site is never hard
// deleted — see the DELETE handler.
export const opsJobsRouter = Router()
opsJobsRouter.use(requireAuth)
opsJobsRouter.use(requireVerifiedForMutation)

// Status is a closed set, so an unrecognized ?status= is a 400 from parseQuery
// rather than being dropped from the where clause — silently ignoring it would
// return the unfiltered list and read as "there are no archived sites".
const statusField = z.enum(['ACTIVE', 'ARCHIVED'])
const riskLevelField = z.enum(['LOW', 'MEDIUM', 'HIGH'])

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  status: statusField.optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

// GET /api/ops/jobs — job sites for the workspace, filterable and paginated.
opsJobsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')
    const { page, limit, skip } = clampPagination(q.page, q.limit)

    const where = {
      workspaceId: q.workspaceId,
      ...(q.status ? { status: q.status } : {}),
    }

    const [jobSites, total] = await Promise.all([
      prisma.opsJobSite.findMany({ where, orderBy: [{ status: 'asc' }, { siteName: 'asc' }], skip, take: limit }),
      prisma.opsJobSite.count({ where }),
    ])

    res.json({ jobSites, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

const createSchema = z.object({
  workspaceId: workspaceIdField,
  jobCode: nonEmptyString.max(64),
  siteName: nonEmptyString.max(200),
  location: z.string().trim().max(200).optional(),
  supervisor: z.string().trim().max(200).optional(),
  // Free-text descriptive label ("Day", "Night", "Rotating") — deliberately not
  // an enum, matching the schema; OpsRosterEntry.shiftType is the enum one.
  shiftType: z.string().trim().max(64).optional(),
  riskLevel: riskLevelField.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().int().min(10).max(100_000).optional(),
  notes: z.string().trim().max(2000).optional(),
})
type _CreateJobSiteConforms = Assert<Extends<z.infer<typeof createSchema>, OpsCreateJobSiteRequest>>

// POST /api/ops/jobs — register a site. status is NOT accepted from the body: a
// site is always born ACTIVE and only ever reaches ARCHIVED through the archive
// endpoint below, so the lifecycle change is always audited.
opsJobsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const data = parseBody(createSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')

    let jobSite
    try {
      jobSite = await prisma.opsJobSite.create({
        data: {
          workspaceId: data.workspaceId, jobCode: data.jobCode, siteName: data.siteName,
          location: data.location, supervisor: data.supervisor, shiftType: data.shiftType,
          status: 'ACTIVE', riskLevel: data.riskLevel ?? 'MEDIUM',
          lat: data.lat, lng: data.lng, radiusMeters: data.radiusMeters ?? 500, notes: data.notes,
        },
      })
    } catch (err) {
      // P2002 on (workspaceId, jobCode): the code is the workspace's human-facing
      // handle for the site, so a collision is a caller mistake (409), not a 500.
      if ((err as { code?: string }).code === 'P2002') throw new ApiError(409, 'A job site with this job code already exists')
      throw err
    }
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.jobsite.created', entityType: 'OpsJobSite', entityId: jobSite.id })

    res.status(201).json({ jobSite })
  })
)

const idParamsSchema = z.object({ id: idField })

// Explicit allowlist. jobCode is immutable here (shift/roster history and the
// workspace's own paperwork refer to a site by its code), and status is absent
// on purpose — archiving is a lifecycle action with its own endpoint and audit
// entry, not a field edit.
const updateSchema = z.object({
  workspaceId: workspaceIdField,
  siteName: nonEmptyString.max(200).optional(),
  location: z.string().trim().max(200).optional(),
  supervisor: z.string().trim().max(200).optional(),
  shiftType: z.string().trim().max(64).optional(),
  riskLevel: riskLevelField.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().int().min(10).max(100_000).optional(),
  notes: z.string().trim().max(2000).optional(),
})
type _UpdateJobSiteConforms = Assert<Extends<z.infer<typeof updateSchema>, OpsUpdateJobSiteRequest>>

// PUT /api/ops/jobs/:id — edit site details.
opsJobsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const data = parseBody(updateSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')

    const existing = await prisma.opsJobSite.findFirst({ where: { id, workspaceId: data.workspaceId } })
    if (!existing) throw new ApiError(404, 'Job site not found')

    const updated = await prisma.opsJobSite.update({
      where: { id },
      data: {
        ...(data.siteName !== undefined ? { siteName: data.siteName } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.supervisor !== undefined ? { supervisor: data.supervisor } : {}),
        ...(data.shiftType !== undefined ? { shiftType: data.shiftType } : {}),
        ...(data.riskLevel !== undefined ? { riskLevel: data.riskLevel } : {}),
        ...(data.lat !== undefined ? { lat: data.lat } : {}),
        ...(data.lng !== undefined ? { lng: data.lng } : {}),
        ...(data.radiusMeters !== undefined ? { radiusMeters: data.radiusMeters } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    })
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.jobsite.updated', entityType: 'OpsJobSite', entityId: id })

    res.json({ jobSite: updated })
  })
)

const deleteQuerySchema = z.object({ workspaceId: workspaceIdField })

// DELETE /api/ops/jobs/:id — archives rather than removes. OpsShiftRecord and
// OpsRosterEntry hold the site with onDelete: Restrict, so a hard delete would
// fail outright the moment a site has any history; archiving also keeps that
// history readable. `status: { not: 'ARCHIVED' }` is part of the lookup so
// re-archiving an already-archived site 404s instead of re-auditing a no-op.
opsJobsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(deleteQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const existing = await prisma.opsJobSite.findFirst({ where: { id, workspaceId, status: { not: 'ARCHIVED' } } })
    if (!existing) throw new ApiError(404, 'Job site not found')
    await prisma.opsJobSite.update({ where: { id }, data: { status: 'ARCHIVED' } })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.jobsite.archived', entityType: 'OpsJobSite', entityId: id })

    res.json({ archived: true, id })
  })
)
