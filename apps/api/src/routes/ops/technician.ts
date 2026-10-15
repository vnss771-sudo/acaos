import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { userBelongsToWorkspace } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { parseBody, parseParams, parseQuery, workspaceIdField, idField } from '../../lib/validate.js'
import { auditOps } from './utils.js'

export const technicianRouter = Router()
technicianRouter.use(requireAuth)
technicianRouter.use(requireVerifiedForMutation)

const params = z.object({ jobId: idField })
const scope = z.object({ workspaceId: workspaceIdField })
const assignBody = scope.extend({ crewMemberId: idField })
const evidenceBody = scope.extend({
  kind: z.enum(['NOTE', 'CHECKLIST']),
  submissionId: z.string().uuid(),
  // No user-provided file URLs or HTML. Photo storage is deliberately deferred.
  note: z.string().trim().min(1).max(4000).optional(),
  checklist: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    checked: z.boolean(),
  })).min(1).max(100).optional(),
}).superRefine((v, ctx) => {
  if (v.kind === 'NOTE' && !v.note) ctx.addIssue({ code: 'custom', message: 'note required' })
  if (v.kind === 'CHECKLIST' && !v.checklist) ctx.addIssue({ code: 'custom', message: 'checklist required' })
})

// JSONB does not preserve object key order, so compare canonically.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

async function getJob(workspaceId: string, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, workspaceId },
    select: { id: true, status: true, opsJobSiteId: true },
  })
  if (!job) throw new ApiError(404, 'Job not found')
  return job
}

async function access(userId: string, workspaceId: string, jobId: string) {
  if (!(await userBelongsToWorkspace(userId, workspaceId))) throw new ApiError(403, 'Access denied')
  const job = await getJob(workspaceId, jobId)
  const crew = await prisma.opsCrewMember.findFirst({
    where: { workspaceId, userId, isActive: true }, select: { id: true },
  })
  if (!crew) throw new ApiError(403, 'No active linked crew account')
  const assigned = await prisma.jobTechnicianAssignment.findFirst({
    where: { workspaceId, jobId, crewMemberId: crew.id }, select: { id: true },
  })
  if (!assigned) throw new ApiError(403, 'Not assigned to this job')
  return { job, crewMemberId: crew.id }
}

// Admin-only assignment; both resources must belong to the same workspace.
technicianRouter.post('/:jobId/assignments', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { jobId } = parseParams(params, req)
  const data = parseBody(assignBody, req)
  await assertWorkspacePermission(user.id, data.workspaceId, 'ops:manage')
  const job = await getJob(data.workspaceId, jobId)
  if (job.status !== 'ACTIVE') throw new ApiError(409, 'Job is not active')
  const crew = await prisma.opsCrewMember.findFirst({
    where: { id: data.crewMemberId, workspaceId: data.workspaceId, isActive: true },
    select: { id: true },
  })
  if (!crew) throw new ApiError(404, 'Crew member not found')
  const assignment = await prisma.jobTechnicianAssignment.upsert({
    where: { workspaceId_jobId_crewMemberId: {
      workspaceId: data.workspaceId, jobId, crewMemberId: crew.id,
    } },
    update: {},
    create: { workspaceId: data.workspaceId, jobId, crewMemberId: crew.id },
  })
  auditOps({ workspaceId: data.workspaceId, actorUserId: user.id,
    type: 'ops.technician.assigned', entityType: 'JobTechnicianAssignment', entityId: assignment.id })
  res.status(201).json({ assignment })
}))

// Revocation removes future access, but retains historical evidence and authorship.
technicianRouter.delete('/:jobId/assignments/:crewMemberId', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { jobId, crewMemberId } = parseParams(z.object({ jobId: idField, crewMemberId: idField }), req)
  const { workspaceId } = parseQuery(scope, req)
  await assertWorkspacePermission(user.id, workspaceId, 'ops:manage')
  await getJob(workspaceId, jobId)
  // Lock the delivery Job first, matching the evidence submission lock order.
  // A submission that already holds this lock finishes before revocation;
  // submissions starting afterwards observe the deleted assignment.
  const deleted = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Job" WHERE "id" = ${jobId} AND "workspaceId" = ${workspaceId} FOR UPDATE`
    if (!rows.length) throw new ApiError(404, 'Job not found')
    return tx.jobTechnicianAssignment.deleteMany({ where: { workspaceId, jobId, crewMemberId } })
  })
  if (!deleted.count) throw new ApiError(404, 'Assignment not found')
  auditOps({ workspaceId, actorUserId: user.id,
    type: 'ops.technician.unassigned', entityType: 'Job', entityId: jobId })
  res.json({ revoked: true })
}))

technicianRouter.get('/:jobId/evidence', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { jobId } = parseParams(params, req)
  const { workspaceId } = parseQuery(scope, req)
  await access(user.id, workspaceId, jobId)
  const evidence = await prisma.jobTechnicianEvidence.findMany({
    where: { workspaceId, jobId }, orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, kind: true, content: true, createdAt: true },
  })
  res.json({ evidence })
}))

technicianRouter.post('/:jobId/evidence', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { jobId } = parseParams(params, req)
  const data = parseBody(evidenceBody, req)
  const { crewMemberId } = await access(user.id, data.workspaceId, jobId)
  const content = data.kind === 'NOTE' ? { note: data.note } : { checklist: data.checklist }
  // Row lock serialises submission against closeout updates to this Job.
  // The assignment check is repeated under the lock to close the revocation race.
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "Job" WHERE "id" = ${jobId} AND "workspaceId" = ${data.workspaceId} FOR UPDATE`
    if (!rows.length) throw new ApiError(404, 'Job not found')
    if (rows[0].status !== 'ACTIVE') throw new ApiError(409, 'Job is not active')
    const assigned = await tx.jobTechnicianAssignment.findFirst({
      where: { workspaceId: data.workspaceId, jobId, crewMemberId }, select: { id: true },
    })
    if (!assigned) throw new ApiError(403, 'Assignment revoked')
    const key = { workspaceId: data.workspaceId, crewMemberId, submissionId: data.submissionId }
    const existing = await tx.jobTechnicianEvidence.findUnique({
      where: { workspaceId_crewMemberId_submissionId: key },
      select: { id: true, jobId: true, kind: true, content: true, createdAt: true },
    })
    if (existing) {
      if (existing.jobId !== jobId || existing.kind !== data.kind ||
          canonical(existing.content) !== canonical(content)) {
        throw new ApiError(409, 'Submission ID already used for different evidence')
      }
      return { evidence: existing, created: false }
    }
    const evidence = await tx.jobTechnicianEvidence.create({
      data: { workspaceId: data.workspaceId, jobId, crewMemberId,
        submissionId: data.submissionId, kind: data.kind, content },
      select: { id: true, jobId: true, kind: true, content: true, createdAt: true },
    })
    return { evidence, created: true }
  })
  if (result.created) {
    auditOps({ workspaceId: data.workspaceId, actorUserId: user.id,
      type: 'ops.technician.evidence.created', entityType: 'JobTechnicianEvidence', entityId: result.evidence.id })
  }
  res.status(result.created ? 201 : 200).json({ evidence: result.evidence })
}))
