import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseQuery, parseBody, parseParams, workspaceIdField, idField, nonEmptyString } from '../../lib/validate.js'
import { clampPagination, auditOps } from './utils.js'
import type { Assert, Extends, OpsCreateCrewRequest, OpsUpdateCrewRequest } from '@acaos/shared'

// Crew members: the people a workspace rosters, clocks in, and pays. This is the
// root record the rest of the Ops module points at (shifts.ts, clock.ts and the
// roster all take a crewMemberId), so it has no cross-references of its own to
// re-validate — assertOwnership runs on the routes that REFERENCE a crew member,
// not here. Reading is member-level; every mutation is 'ops:manage' (admin+).
export const crewRouter = Router()
crewRouter.use(requireAuth)
crewRouter.use(requireVerifiedForMutation)

const listQuerySchema = z.object({
  workspaceId: workspaceIdField,
  search: z.string().trim().max(200).optional(),
  // 'true'/'false' rather than a coerced boolean: z.coerce.boolean() treats any
  // non-empty string as true, so `?active=false` would silently mean "active".
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

// GET /api/ops/crew — roster directory, searchable and paginated.
crewRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const q = parseQuery(listQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, q.workspaceId))) throw new ApiError(403, 'Access denied')
    const { page, limit, skip } = clampPagination(q.page, q.limit)

    const where = {
      workspaceId: q.workspaceId,
      ...(q.active !== undefined ? { isActive: q.active === 'true' } : {}),
      ...(q.search
        ? {
            OR: [
              { fullName: { contains: q.search, mode: 'insensitive' as const } },
              { employeeCode: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [crew, total] = await Promise.all([
      prisma.opsCrewMember.findMany({ where, orderBy: { fullName: 'asc' }, skip, take: limit }),
      prisma.opsCrewMember.count({ where }),
    ])

    res.json({ crew, total, page, limit, pages: Math.ceil(total / limit) })
  })
)

const createSchema = z.object({
  workspaceId: workspaceIdField,
  employeeCode: nonEmptyString.max(64),
  fullName: nonEmptyString.max(200),
  role: nonEmptyString.max(64),
  crewName: z.string().trim().max(120).optional(),
  baseRate: z.number().min(0).optional(),
  allowanceProfile: z.string().trim().max(64).optional(),
  licenceNotes: z.string().trim().max(2000).optional(),
  userId: idField.nullable().optional(),
})

// Compile-time guard: the validated request must satisfy the shared contract the
// frontend is typed against. If the zod schema drifts from the contract, this fails.
type _CreateCrewConforms = Assert<Extends<z.infer<typeof createSchema>, OpsCreateCrewRequest>>

// POST /api/ops/crew — add a crew member. employeeCode is unique per workspace
// ((workspaceId, employeeCode) in the schema), so a duplicate is a caller error
// (409), not a 500: catch the constraint violation rather than racing a
// check-then-create, which two concurrent imports could both pass. Linking a
// userId re-validates that user actually belongs to this workspace — without
// that check, an admin could bind a crew record (and its clock-in identity) to
// a user from an unrelated workspace.
crewRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const data = parseBody(createSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')
    if (data.userId && !(await userBelongsToWorkspace(data.userId, data.workspaceId))) {
      throw new ApiError(400, 'userId does not belong to this workspace')
    }

    let crew
    try {
      crew = await prisma.opsCrewMember.create({
        data: {
          workspaceId: data.workspaceId, employeeCode: data.employeeCode, fullName: data.fullName, role: data.role,
          crewName: data.crewName, baseRate: data.baseRate, allowanceProfile: data.allowanceProfile, licenceNotes: data.licenceNotes,
          userId: data.userId,
        },
      })
    } catch (err) {
      const prismaErr = err as { code?: string; meta?: { target?: string[] } }
      if (prismaErr.code === 'P2002') {
        if (prismaErr.meta?.target?.includes('userId')) throw new ApiError(409, 'That user is already linked to another crew member')
        throw new ApiError(409, 'A crew member with this employee code already exists')
      }
      throw err
    }
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.crew.created', entityType: 'OpsCrewMember', entityId: crew.id })

    res.status(201).json({ crew })
  })
)

const idParamsSchema = z.object({ id: idField })

// employeeCode is deliberately absent: it is the stable identifier payroll and
// any imported timesheet join on, so it is immutable through this route. A
// re-code is a distinct, separately audited operation if it is ever needed.
const updateSchema = z.object({
  workspaceId: workspaceIdField,
  fullName: nonEmptyString.max(200).optional(),
  role: nonEmptyString.max(64).optional(),
  crewName: z.string().trim().max(120).optional(),
  baseRate: z.number().min(0).optional(),
  allowanceProfile: z.string().trim().max(64).optional(),
  licenceNotes: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
  userId: idField.nullable().optional(),
})
type _UpdateCrewConforms = Assert<Extends<z.infer<typeof updateSchema>, OpsUpdateCrewRequest>>

// PUT /api/ops/crew/:id — edit a crew member. The update object is built field
// by field from the parsed body (never a spread of req.body), so an unexpected
// key can't reach Prisma even if the schema later gains a passthrough.
crewRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const data = parseBody(updateSchema, req)
    await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')

    const existing = await prisma.opsCrewMember.findFirst({ where: { id, workspaceId: data.workspaceId } })
    if (!existing) throw new ApiError(404, 'Crew member not found')
    if (data.userId && !(await userBelongsToWorkspace(data.userId, data.workspaceId))) {
      throw new ApiError(400, 'userId does not belong to this workspace')
    }

    let updated
    try {
      updated = await prisma.opsCrewMember.update({
        where: { id },
        data: {
          ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
          ...(data.role !== undefined ? { role: data.role } : {}),
          ...(data.crewName !== undefined ? { crewName: data.crewName } : {}),
          ...(data.baseRate !== undefined ? { baseRate: data.baseRate } : {}),
          ...(data.allowanceProfile !== undefined ? { allowanceProfile: data.allowanceProfile } : {}),
          ...(data.licenceNotes !== undefined ? { licenceNotes: data.licenceNotes } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          ...(data.userId !== undefined ? { userId: data.userId } : {}),
        },
      })
    } catch (err) {
      const prismaErr = err as { code?: string; meta?: { target?: string[] } }
      if (prismaErr.code === 'P2002' && prismaErr.meta?.target?.includes('userId')) {
        throw new ApiError(409, 'That user is already linked to another crew member')
      }
      throw err
    }
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id, type: 'ops.crew.updated', entityType: 'OpsCrewMember', entityId: id })

    res.json({ crew: updated })
  })
)

const deleteQuerySchema = z.object({ workspaceId: workspaceIdField })

// DELETE /api/ops/crew/:id — deactivate, never hard-delete. OpsShiftRecord and
// OpsRosterEntry reference crewMemberId with onDelete: Restrict, so a real delete
// would fail the moment a crew member has any history — and even when it would
// succeed, discarding the person a compliance-relevant shift record belongs to is
// the wrong outcome. isActive: false removes them from the active roster while
// leaving every historical row intact and attributable.
crewRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = parseParams(idParamsSchema, req)
    const { workspaceId } = parseQuery(deleteQuerySchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')

    const existing = await prisma.opsCrewMember.findFirst({ where: { id, workspaceId } })
    if (!existing) throw new ApiError(404, 'Crew member not found')
    await prisma.opsCrewMember.update({ where: { id }, data: { isActive: false } })
    auditOps({ workspaceId, actorUserId: user.id, type: 'ops.crew.deactivated', entityType: 'OpsCrewMember', entityId: id })

    res.json({ deactivated: true, id })
  })
)
