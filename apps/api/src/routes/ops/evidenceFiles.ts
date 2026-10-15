// Technician evidence files (C2): upload initiation, completion and status.
//
// The API never receives file bytes. `init` records an upload intent and returns a
// short-lived signed PUT bound to an exact key, content type and byte length;
// `complete` checks the object arrived and queues finalisation; the worker does all
// validation and sanitisation (see worker/processors/evidenceFinalize.ts).
//
// Everything here is behind the server-side evidence-uploads flag and FAILS CLOSED:
// with the flag off or the storage configuration missing/invalid, every endpoint
// answers 503 and touches neither the database nor storage.
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import type { Prisma } from '@prisma/client'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { resolveEvidenceStorage, describeEvidenceStorageProblems, type EvidenceStorageConfig } from '@acaos/backend-core/lib/evidenceStorageConfig.js'
import { getEvidenceStore, newEvidenceKeys, assertKeyForJob } from '@acaos/backend-core/lib/evidenceStorage.js'
import { ALLOWED_EVIDENCE_TYPES } from '@acaos/backend-core/lib/evidenceTypes.js'
import { enqueueFinalizeEvidenceFile } from '@acaos/backend-core/lib/queues.js'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { createRateLimiter } from '../../middleware/rateLimit.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { getWorkspaceRole } from '../../lib/workspaces.js'
import { roleCan } from '../../lib/permissions.js'
import { parseBody, parseParams, parseQuery, workspaceIdField, idField } from '../../lib/validate.js'
import { auditOps } from './utils.js'
import { technicianAccess } from './technician.js'

export const technicianFilesRouter = Router()
technicianFilesRouter.use(requireAuth)
technicianFilesRouter.use(requireVerifiedForMutation)

const perUser = (name: string, max: number) => createRateLimiter({
  windowMs: 60_000, max, name, keyFn: (req) => req.user?.id ?? null,
  message: 'Too many upload requests, please slow down.',
})
const initLimiter = perUser('evidence-file-init', 30)
const completeLimiter = perUser('evidence-file-complete', 60)

const scope = z.object({ workspaceId: workspaceIdField })
const jobParams = z.object({ jobId: idField })
const fileParams = z.object({ jobId: idField, fileId: idField })
const initBody = scope.extend({
  submissionId: z.string().uuid(),
  contentType: z.enum(ALLOWED_EVIDENCE_TYPES),
  sizeBytes: z.number().int().min(1),
  evidenceId: idField.optional(),
})

// Tests replace the queue producer (the DB test tier has no Redis). Refused in production.
let enqueueFinalize: typeof enqueueFinalizeEvidenceFile = enqueueFinalizeEvidenceFile
export function setFinalizeEnqueuerForTests(fn: typeof enqueueFinalizeEvidenceFile | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setFinalizeEnqueuerForTests is not available in production')
  enqueueFinalize = fn ?? enqueueFinalizeEvidenceFile
}

/** Resolve the storage config or refuse the request. Logs why, never a secret. */
function requireEvidenceStorage(): EvidenceStorageConfig {
  const state = resolveEvidenceStorage()
  if (state.enabled) return state.config
  const why = describeEvidenceStorageProblems(state)
  if (why) logger.error(why, { service: 'api' })
  throw new ApiError(503, 'Evidence uploads are not enabled')
}

type Tx = Prisma.TransactionClient
type CopyRow = { id: string; location: string; objectKey: string; sizeBytes: number | null }
type ExistingFile = {
  id: string; jobId: string; status: string; kind: string; contentType: string | null; copies: CopyRow[]
}

const publicFile = (f: { id: string; status: string; kind: string }) => ({ id: f.id, status: f.status, kind: f.kind })

// POST /:jobId/files/init
technicianFilesRouter.post('/:jobId/files/init', initLimiter, asyncHandler(async (req, res) => {
  const cfg = requireEvidenceStorage()
  const user = requireUser(req)
  const { jobId } = parseParams(jobParams, req)
  const body = parseBody(initBody, req)
  const { crewMemberId } = await technicianAccess(user.id, body.workspaceId, jobId)
  if (body.sizeBytes > cfg.maxUploadBytes) throw new ApiError(413, 'File exceeds the maximum upload size')

  const result = await prisma.$transaction(async (tx: Tx) => {
    // Same lock as evidence submit, revocation, closeout and finalisation.
    const jobRows = (await tx.$queryRaw`
      SELECT "status" FROM "Job" WHERE "id" = ${jobId} AND "workspaceId" = ${body.workspaceId} FOR UPDATE`) as Array<{ status: string }>
    if (!jobRows.length) throw new ApiError(404, 'Job not found')
    if (jobRows[0].status !== 'ACTIVE') throw new ApiError(409, 'Job is not active')
    const assigned = await tx.jobTechnicianAssignment.findFirst({
      where: { workspaceId: body.workspaceId, jobId, crewMemberId }, select: { id: true },
    })
    if (!assigned) throw new ApiError(403, 'Assignment revoked')
    const crew = await tx.opsCrewMember.findFirst({
      where: { id: crewMemberId, workspaceId: body.workspaceId, isActive: true }, select: { id: true },
    })
    if (!crew) throw new ApiError(403, 'No active linked crew account')

    // Idempotent retry of the same submission.
    const existing = (await tx.evidenceFile.findUnique({
      where: { workspaceId_crewMemberId_submissionId: { workspaceId: body.workspaceId, crewMemberId, submissionId: body.submissionId } },
      select: {
        id: true, jobId: true, status: true, kind: true, contentType: true,
        copies: { select: { id: true, location: true, objectKey: true, sizeBytes: true } },
      },
    })) as ExistingFile | null
    if (existing) {
      const upload = existing.copies.find((c: CopyRow) => c.location === 'upload')
      const sameRequest = existing.jobId === jobId && (existing.status !== 'PENDING' ||
        (existing.contentType === body.contentType && upload?.sizeBytes === body.sizeBytes))
      if (!sameRequest) throw new ApiError(409, 'Submission ID already used for a different upload')
      return { file: existing, created: false, uploadKey: existing.status === 'PENDING' ? upload?.objectKey ?? null : null }
    }

    // Limits: per job, per technician (unfinished uploads) and per workspace.
    const onJob = await tx.evidenceFile.count({ where: { workspaceId: body.workspaceId, jobId, status: { in: ['PENDING', 'AVAILABLE'] } } })
    if (onJob >= cfg.maxFilesPerJob) throw new ApiError(409, 'This job has reached its file limit')
    const pending = await tx.evidenceFile.count({ where: { workspaceId: body.workspaceId, crewMemberId, status: 'PENDING' } })
    if (pending >= cfg.maxPendingPerWorker) throw new ApiError(429, 'Too many unfinished uploads; complete them or wait for them to expire')
    const stored = await tx.evidenceFile.aggregate({ where: { workspaceId: body.workspaceId, status: 'AVAILABLE' }, _sum: { sizeBytes: true } })
    const inflight = await tx.evidenceFileCopy.aggregate({
      where: { workspaceId: body.workspaceId, location: 'upload', status: 'PENDING', file: { status: 'PENDING' } }, _sum: { sizeBytes: true },
    })
    if ((stored._sum.sizeBytes ?? 0) + (inflight._sum.sizeBytes ?? 0) + body.sizeBytes > cfg.workspaceQuotaBytes) {
      throw new ApiError(409, 'This workspace has reached its evidence storage quota')
    }

    if (body.evidenceId) {
      // The evidence row must be this technician's own, on this job (the composite FK
      // also pins workspace + job; this gives a clean 404 instead of a constraint error).
      const ev = await tx.jobTechnicianEvidence.findFirst({
        where: { id: body.evidenceId, workspaceId: body.workspaceId, jobId, crewMemberId }, select: { id: true },
      })
      if (!ev) throw new ApiError(404, 'Evidence not found')
    }

    const keys = newEvidenceKeys(body.workspaceId, jobId)
    const created = await tx.evidenceFile.create({
      data: {
        workspaceId: body.workspaceId, jobId, crewMemberId, submissionId: body.submissionId,
        evidenceId: body.evidenceId ?? null, kind: 'PHOTO', status: 'PENDING', contentType: body.contentType,
      },
      select: { id: true, jobId: true, status: true, kind: true, contentType: true },
    }) as Omit<ExistingFile, 'copies'>
    // Three locations: the raw upload (deleted after finalisation) and the final published object.
    await tx.evidenceFileCopy.createMany({
      data: [
        { workspaceId: body.workspaceId, fileId: created.id, location: 'upload', objectKey: keys.uploadKey, sizeBytes: body.sizeBytes },
        { workspaceId: body.workspaceId, fileId: created.id, location: 'primary', objectKey: keys.primaryKey },
        // Gallery thumbnail, produced at finalisation. Recorded up front so every cleanup path
        // (reject, sweep, C4 deletion) already knows the key. It stays PENDING until it exists.
        { workspaceId: body.workspaceId, fileId: created.id, location: 'thumb', objectKey: keys.thumbKey },
      ],
    })
    return { file: { ...created, copies: [] as CopyRow[] }, created: true, uploadKey: keys.uploadKey }
  }) as { file: ExistingFile; created: boolean; uploadKey: string | null }

  if (result.created) {
    auditOps({ workspaceId: body.workspaceId, actorUserId: user.id,
      type: 'ops.technician.file.upload_started', entityType: 'EvidenceFile', entityId: result.file.id })
  }
  if (!result.uploadKey) {
    // Already final (or rejected): nothing to upload; tell the client where it stands.
    return res.status(200).json({ file: publicFile(result.file) })
  }
  const expiresAt = new Date(Date.now() + cfg.presignTtlSeconds * 1000)
  const signed = await getEvidenceStore(cfg).presignPut({
    key: result.uploadKey, contentType: body.contentType, contentLength: body.sizeBytes, expiresInSeconds: cfg.presignTtlSeconds,
  })
  res.status(result.created ? 201 : 200).json({
    file: publicFile(result.file),
    upload: { method: 'PUT', url: signed.url, headers: signed.headers, expiresAt: expiresAt.toISOString() },
  })
}))

// Shared lookup: the file must belong to this job AND to the calling technician.
async function ownFile(workspaceId: string, jobId: string, fileId: string, crewMemberId: string) {
  const file = (await prisma.evidenceFile.findFirst({
    where: { id: fileId, workspaceId, jobId, crewMemberId },
    select: {
      id: true, status: true, kind: true, contentType: true, sizeBytes: true, width: true, height: true, createdAt: true, finalizedAt: true,
      copies: { select: { id: true, location: true, objectKey: true, sizeBytes: true } },
    },
  })) as (ExistingFile & { sizeBytes: number | null; width: number | null; height: number | null; createdAt: Date; finalizedAt: Date | null }) | null
  // Another technician's file on the same job is indistinguishable from a missing one.
  if (!file) throw new ApiError(404, 'File not found')
  return file
}

// POST /:jobId/files/:fileId/complete
technicianFilesRouter.post('/:jobId/files/:fileId/complete', completeLimiter, asyncHandler(async (req, res) => {
  const cfg = requireEvidenceStorage()
  const user = requireUser(req)
  const { jobId, fileId } = parseParams(fileParams, req)
  const { workspaceId } = parseBody(scope, req)
  const { job, crewMemberId } = await technicianAccess(user.id, workspaceId, jobId)
  const file = await ownFile(workspaceId, jobId, fileId, crewMemberId)

  if (file.status === 'AVAILABLE' || file.status === 'REJECTED') return res.status(200).json({ file: publicFile(file) })
  if (file.status !== 'PENDING') throw new ApiError(410, 'File is no longer available')
  if (job.status !== 'ACTIVE') throw new ApiError(409, 'Job is not active')

  const upload = file.copies.find((c: CopyRow) => c.location === 'upload')
  if (!upload) throw new ApiError(409, 'Upload record is incomplete')
  const head = await getEvidenceStore(cfg).head(upload.objectKey)
  if (!head) throw new ApiError(409, 'Upload not found; it may not have finished or its link has expired')

  await enqueueFinalize({ workspaceId, fileId })
  auditOps({ workspaceId, actorUserId: user.id, type: 'ops.technician.file.upload_completed', entityType: 'EvidenceFile', entityId: file.id })
  res.status(202).json({ file: publicFile(file), processing: true })
}))

// GET /:jobId/files/:fileId — status for polling. The owning technician, or a manager of this workspace.
technicianFilesRouter.get('/:jobId/files/:fileId', asyncHandler(async (req, res) => {
  requireEvidenceStorage()
  const user = requireUser(req)
  const { jobId, fileId } = parseParams(fileParams, req)
  const { workspaceId } = parseQuery(scope, req)
  const role = await getWorkspaceRole(user.id, workspaceId)
  let file
  if (roleCan(role, 'ops:manage')) {
    file = (await prisma.evidenceFile.findFirst({
      where: { id: fileId, workspaceId, jobId },
      select: { id: true, status: true, kind: true, contentType: true, sizeBytes: true, width: true, height: true, createdAt: true, finalizedAt: true },
    })) as { id: string; status: string; kind: string; contentType: string | null; sizeBytes: number | null; width: number | null; height: number | null; createdAt: Date; finalizedAt: Date | null } | null
    if (!file) throw new ApiError(404, 'File not found')
  } else {
    const { crewMemberId } = await technicianAccess(user.id, workspaceId, jobId)
    file = await ownFile(workspaceId, jobId, fileId, crewMemberId)
  }
  res.json({ file: {
    id: file.id, status: file.status, kind: file.kind, contentType: file.contentType, sizeBytes: file.sizeBytes,
    width: file.width, height: file.height, createdAt: file.createdAt, finalizedAt: file.finalizedAt,
  } })
}))

// ── read side (C5a) ─────────────────────────────────────────────────────────
// Who may read what:
//  - managers (ops:manage) read every AVAILABLE file on any job in their workspace;
//  - a technician reads only their OWN files, and only while they are still assigned to the
//    job AND the job is ACTIVE (product decision: no read access after closeout/revocation;
//    managers keep the historical record).
// Another technician's file, a file on another job and a file in another workspace are all
// the same 404. No response ever contains an object key.
const readLimiter = perUser('evidence-file-read', 120)
const contentLimiter = perUser('evidence-file-content', 120)
const cancelLimiter = perUser('evidence-file-cancel', 30)

const listQuery = scope.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
})
const contentQuery = scope.extend({ variant: z.enum(['full', 'thumb']).default('full') })
const cursorShape = z.object({ t: z.string().datetime(), i: idField })

function decodeCursor(raw: string) {
  try {
    const c = cursorShape.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
    return { createdAt: new Date(c.t), id: c.i }
  } catch {
    throw new ApiError(400, 'Invalid cursor')
  }
}

type ReadScope = { manager: true } | { manager: false; crewMemberId: string }

async function readScope(userId: string, workspaceId: string, jobId: string): Promise<ReadScope> {
  const role = await getWorkspaceRole(userId, workspaceId)
  if (roleCan(role, 'ops:manage')) {
    const job = await prisma.job.findFirst({ where: { id: jobId, workspaceId }, select: { id: true } })
    if (!job) throw new ApiError(404, 'Job not found')
    return { manager: true }
  }
  const { job, crewMemberId } = await technicianAccess(userId, workspaceId, jobId)
  if (job.status !== 'ACTIVE') throw new ApiError(409, 'Job is not active')
  return { manager: false, crewMemberId }
}

// GET /:jobId/files: keyset-paginated list, newest first.
technicianFilesRouter.get('/:jobId/files', readLimiter, asyncHandler(async (req, res) => {
  requireEvidenceStorage()
  const user = requireUser(req)
  const { jobId } = parseParams(jobParams, req)
  const { workspaceId, limit, cursor } = parseQuery(listQuery, req)
  const who = await readScope(user.id, workspaceId, jobId)
  const after = cursor ? decodeCursor(cursor) : null
  type Row = {
    id: string; status: string; kind: string; contentType: string | null; sizeBytes: number | null
    width: number | null; height: number | null; evidenceId: string | null; createdAt: Date; finalizedAt: Date | null
    crewMemberId: string; crewMember: { fullName: string }; copies: Array<{ id: string }>
  }
  const rows = (await prisma.evidenceFile.findMany({
    where: {
      workspaceId, jobId,
      // Managers see evidence; a technician also sees their own in-flight and rejected uploads
      // so the app can reconcile its queue after a reload. Tombstoned files are never listed.
      ...(who.manager ? { status: 'AVAILABLE' } : { crewMemberId: who.crewMemberId, status: { in: ['PENDING', 'AVAILABLE', 'REJECTED'] } }),
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true, status: true, kind: true, contentType: true, sizeBytes: true, width: true, height: true,
      evidenceId: true, createdAt: true, finalizedAt: true, crewMemberId: true,
      crewMember: { select: { fullName: true } },
      copies: { where: { location: 'thumb', status: 'VERIFIED' }, select: { id: true } },
    },
  })) as Row[]
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ t: last.createdAt.toISOString(), i: last.id })).toString('base64url')
    : null
  res.set('Cache-Control', 'no-store')
  res.json({
    files: page.map((f) => ({
      id: f.id, status: f.status, kind: f.kind, contentType: f.contentType, sizeBytes: f.sizeBytes,
      width: f.width, height: f.height, evidenceId: f.evidenceId, createdAt: f.createdAt, finalizedAt: f.finalizedAt,
      hasThumb: f.copies.length > 0,
      ...(who.manager ? { uploadedBy: { crewMemberId: f.crewMemberId, name: f.crewMember.fullName } } : {}),
    })),
    nextCursor,
  })
}))

// GET /:jobId/files/:fileId/content: a short-lived signed GET for one AVAILABLE file.
technicianFilesRouter.get('/:jobId/files/:fileId/content', contentLimiter, asyncHandler(async (req, res) => {
  const cfg = requireEvidenceStorage()
  const user = requireUser(req)
  const { jobId, fileId } = parseParams(fileParams, req)
  const { workspaceId, variant } = parseQuery(contentQuery, req)
  const who = await readScope(user.id, workspaceId, jobId)
  const file = (await prisma.evidenceFile.findFirst({
    where: { id: fileId, workspaceId, jobId, ...(who.manager ? {} : { crewMemberId: who.crewMemberId }) },
    select: { id: true, status: true, copies: { select: { location: true, objectKey: true, status: true } } },
  })) as { id: string; status: string; copies: Array<{ location: string; objectKey: string; status: string }> } | null
  if (!file) throw new ApiError(404, 'File not found')
  if (file.status !== 'AVAILABLE') throw new ApiError(409, 'File is not available')
  const copy = file.copies.find((c) => c.location === (variant === 'thumb' ? 'thumb' : 'primary'))
  if (!copy || copy.status !== 'VERIFIED') throw new ApiError(404, variant === 'thumb' ? 'Thumbnail not available' : 'File not found')
  assertKeyForJob(copy.objectKey, workspaceId, jobId)

  const ttl = Math.min(cfg.presignTtlSeconds, 60)
  const signed = await getEvidenceStore(cfg).presignGet({ key: copy.objectKey, expiresInSeconds: ttl, contentType: 'image/jpeg' })
  auditOps({ workspaceId, actorUserId: user.id, type: 'ops.technician.file.viewed', entityType: 'EvidenceFile', entityId: file.id, metadata: { variant } })
  // The signed URL is a bearer credential: never cache or log it.
  res.set('Cache-Control', 'no-store')
  res.json({ url: signed.url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), variant })
}))

// DELETE /:jobId/files/:fileId: a technician cancels their OWN unfinished upload. Finished
// evidence is never removable here (that is retention/legal-hold governance, C4), and the API
// never deletes objects: it marks the file REJECTED and the worker sweeper removes what is left.
technicianFilesRouter.delete('/:jobId/files/:fileId', cancelLimiter, asyncHandler(async (req, res) => {
  requireEvidenceStorage()
  const user = requireUser(req)
  const { jobId, fileId } = parseParams(fileParams, req)
  // The typed route client sends the scope in the body; plain callers may use the query string.
  const { workspaceId } = req.query.workspaceId !== undefined ? parseQuery(scope, req) : parseBody(scope, req)
  const { crewMemberId } = await technicianAccess(user.id, workspaceId, jobId)
  const file = await ownFile(workspaceId, jobId, fileId, crewMemberId)
  if (file.status === 'REJECTED') return res.status(200).json({ file: publicFile(file) })
  if (file.status !== 'PENDING') throw new ApiError(409, 'Uploaded evidence cannot be removed here')
  // Compare-and-set: a finalisation that wins the race makes this a 409 instead.
  const cas = await prisma.evidenceFile.updateMany({
    where: { id: file.id, workspaceId, jobId, crewMemberId, status: 'PENDING' },
    data: { status: 'REJECTED' },
  })
  if (cas.count === 0) throw new ApiError(409, 'Uploaded evidence cannot be removed here')
  auditOps({ workspaceId, actorUserId: user.id, type: 'ops.technician.file.cancelled', entityType: 'EvidenceFile', entityId: file.id })
  res.status(200).json({ file: { id: file.id, status: 'REJECTED', kind: file.kind } })
}))
