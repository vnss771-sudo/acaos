// Evidence governance (C4): retention policy, legal holds and the deletion request
// workflow. Every endpoint is OWNER-ONLY ('evidence:govern', backend-enforced) and
// every change is audited.
//
// The API never deletes anything. Deletion is requested here, reviewed here (which
// seals the approval and starts the waiting period), and executed later by the
// dedicated deletion runner, which holds the only delete-capable credentials. The
// request and review endpoints answer 503 unless the destructive-operations flag and
// seal key are configured (EVIDENCE_DESTRUCTIVE_ENABLED); policy and legal-hold
// endpoints are protective and always available to owners.
import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import type { Prisma } from '@prisma/client'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { resolveDeletionWorkflow } from '@acaos/backend-core/lib/evidenceDeletionConfig.js'
import {
  lockEvidenceGovernance, countActiveHolds, loadPolicy, effectiveRetainUntil, sealApproval, addDays,
  APPROVAL_VALID_DAYS, WAIT_REDUCTION_COOLING_OFF_MS,
} from '@acaos/backend-core/lib/evidenceGovernance.js'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { createRateLimiter } from '../../middleware/rateLimit.js'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { getApiLedger, setApiLedgerForTests } from '../../lib/evidenceLedgerClient.js'
import { parseBody, parseParams, parseQuery, workspaceIdField, idField } from '../../lib/validate.js'
import { auditOps } from './utils.js'

type Tx = Prisma.TransactionClient

export const evidenceGovernanceRouter = Router()
evidenceGovernanceRouter.use(requireAuth)
evidenceGovernanceRouter.use(requireVerifiedForMutation)
evidenceGovernanceRouter.use(createRateLimiter({
  windowMs: 60_000, max: 60, name: 'evidence-governance', keyFn: (req) => req.user?.id ?? null,
  message: 'Too many requests, please slow down.',
}))

const scope = z.object({ workspaceId: workspaceIdField })
const idParams = z.object({ id: idField })
const reasonField = z.string().trim().min(10, 'a reason of at least 10 characters is required').max(2000)

// ── ledger (append-only; best effort for protective actions) ────────────────
export { setApiLedgerForTests, getApiLedger }

/** Release is recorded after the database change; a lost entry is back-filled by the runner (see the route). */
async function ledgerRelease(h: { id: string; workspaceId: string }, actor: string, at: Date): Promise<boolean> {
  const ledger = getApiLedger()
  if (!ledger) return false
  try {
    await ledger.append({ type: 'HOLD_RELEASED', workspaceId: h.workspaceId, holdId: h.id, releasedBy: actor, at: at.toISOString() })
    await prisma.legalHold.updateMany({ where: { id: h.id, workspaceId: h.workspaceId }, data: { releaseLedgeredAt: new Date() } })
    return true
  } catch (e) {
    logger.warn(`hold release not yet in the external ledger: ${(e as Error).message}`, { service: 'evidence-governance' })
    return false
  }
}

function requireWorkflow(): string {
  const w = resolveDeletionWorkflow()
  if (w.enabled) return w.sealKey
  if (w.reason === 'invalid_config') logger.error(`Evidence deletion workflow is DISABLED: ${w.problems.join('; ')}`, { service: 'evidence-governance' })
  throw new ApiError(503, 'Evidence deletion is not enabled')
}

const owner = (userId: string, workspaceId: string) => assertWorkspacePermission(userId, workspaceId, 'evidence:govern')
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002'

// ── retention policy ────────────────────────────────────────────────────────

const policyView = (p: Awaited<ReturnType<typeof loadPolicy>>) => ({
  retentionDays: p.retentionDays, startRule: p.startRule, deletionWaitDays: p.deletionWaitDays,
  requireDistinctReviewer: p.requireDistinctReviewer, autoDeletionEnabled: false,
  pendingWaitDays: p.pendingWaitDays, pendingWaitRequestedAt: p.pendingWaitRequestedAt,
})

evidenceGovernanceRouter.get('/policy', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { workspaceId } = parseQuery(scope, req)
  await owner(user.id, workspaceId)
  res.json({ policy: policyView(await loadPolicy(prisma, workspaceId)) })
}))

// Automatic deletion cannot be switched on here: it stays off until the legal review is
// done, and `.strict()` rejects any attempt to send the field. Retention can be lengthened
// but not shortened through the API; the wait before deletion can be lengthened at once
// and shortened only after a 24 h cooling-off confirmation.
const policyBody = scope.extend({
  deletionWaitDays: z.number().int().min(1).max(365).optional(),
  retentionDays: z.number().int().min(1).max(36500).optional(),
  requireDistinctReviewer: z.boolean().optional(),
}).strict()

evidenceGovernanceRouter.put('/policy', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const body = parseBody(policyBody, req)
  await owner(user.id, body.workspaceId)
  const out = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, body.workspaceId)
    const cur = await loadPolicy(tx, body.workspaceId)
    const data: Record<string, unknown> = { updatedByUserId: user.id }
    let waitStatus: 'unchanged' | 'applied' | 'pending' = 'unchanged'
    if (body.retentionDays !== undefined) {
      if (body.retentionDays < cur.retentionDays) throw new ApiError(409, 'Retention cannot be shortened through the API; it needs a documented legal review')
      data.retentionDays = body.retentionDays
    }
    if (body.requireDistinctReviewer !== undefined) data.requireDistinctReviewer = body.requireDistinctReviewer
    if (body.deletionWaitDays !== undefined && body.deletionWaitDays !== cur.deletionWaitDays) {
      if (body.deletionWaitDays > cur.deletionWaitDays) { data.deletionWaitDays = body.deletionWaitDays; data.pendingWaitDays = null; data.pendingWaitRequestedAt = null; data.pendingWaitRequestedBy = null; waitStatus = 'applied' }
      else { data.pendingWaitDays = body.deletionWaitDays; data.pendingWaitRequestedAt = new Date(); data.pendingWaitRequestedBy = user.id; waitStatus = 'pending' }
    }
    await tx.retentionPolicy.upsert({
      where: { workspaceId: body.workspaceId },
      create: {
        workspaceId: body.workspaceId, updatedByUserId: user.id,
        retentionDays: body.retentionDays ?? cur.retentionDays, requireDistinctReviewer: body.requireDistinctReviewer ?? cur.requireDistinctReviewer,
        deletionWaitDays: waitStatus === 'applied' ? body.deletionWaitDays : cur.deletionWaitDays,
        ...(waitStatus === 'pending' ? { pendingWaitDays: body.deletionWaitDays, pendingWaitRequestedAt: new Date(), pendingWaitRequestedBy: user.id } : {}),
      },
      update: data as never,
    })
    return { policy: policyView(await loadPolicy(tx, body.workspaceId)), waitStatus, before: cur }
  })
  await auditOps({ workspaceId: body.workspaceId, actorUserId: user.id, type: 'evidence.policy.updated', entityType: 'RetentionPolicy', entityId: body.workspaceId, critical: true,
    metadata: { before: { retentionDays: out.before.retentionDays, deletionWaitDays: out.before.deletionWaitDays, requireDistinctReviewer: out.before.requireDistinctReviewer }, requested: { retentionDays: body.retentionDays, deletionWaitDays: body.deletionWaitDays, requireDistinctReviewer: body.requireDistinctReviewer }, waitStatus: out.waitStatus } })
  res.json({ policy: out.policy, waitStatus: out.waitStatus })
}))

evidenceGovernanceRouter.post('/policy/confirm-wait', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { workspaceId } = parseBody(scope.strict(), req)
  await owner(user.id, workspaceId)
  const now = new Date()
  const applied = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, workspaceId)
    const cur = await loadPolicy(tx, workspaceId)
    if (cur.pendingWaitDays == null || !cur.pendingWaitRequestedAt) throw new ApiError(409, 'No pending change to the waiting period')
    if (now.getTime() - cur.pendingWaitRequestedAt.getTime() < WAIT_REDUCTION_COOLING_OFF_MS) throw new ApiError(409, 'A shortened waiting period can be confirmed 24 hours after it was requested')
    await tx.retentionPolicy.update({ where: { workspaceId }, data: { deletionWaitDays: cur.pendingWaitDays, pendingWaitDays: null, pendingWaitRequestedAt: null, pendingWaitRequestedBy: null, updatedByUserId: user.id } })
    return { from: cur.deletionWaitDays, to: cur.pendingWaitDays }
  })
  await auditOps({ workspaceId, actorUserId: user.id, type: 'evidence.policy.wait_confirmed', entityType: 'RetentionPolicy', entityId: workspaceId, critical: true, metadata: applied })
  res.json({ deletionWaitDays: applied.to })
}))

evidenceGovernanceRouter.post('/policy/cancel-wait', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { workspaceId } = parseBody(scope.strict(), req)
  await owner(user.id, workspaceId)
  const r = await prisma.retentionPolicy.updateMany({ where: { workspaceId, pendingWaitDays: { not: null } }, data: { pendingWaitDays: null, pendingWaitRequestedAt: null, pendingWaitRequestedBy: null } })
  if (r.count === 0) throw new ApiError(409, 'No pending change to the waiting period')
  await auditOps({ workspaceId, actorUserId: user.id, type: 'evidence.policy.wait_cancelled', entityType: 'RetentionPolicy', entityId: workspaceId, critical: true })
  res.json({ cancelled: true })
}))

// ── legal holds ─────────────────────────────────────────────────────────────

const holdBody = scope.extend({
  scope: z.enum(['WORKSPACE', 'JOB']), jobId: idField.optional(), reason: reasonField,
}).strict().refine((b) => (b.scope === 'JOB') === (b.jobId !== undefined), { message: 'jobId is required for a JOB hold and not allowed for a WORKSPACE hold' })

evidenceGovernanceRouter.get('/holds', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const q = parseQuery(scope.extend({ active: z.enum(['true', 'false']).optional() }), req)
  await owner(user.id, q.workspaceId)
  const holds = await prisma.legalHold.findMany({
    where: { workspaceId: q.workspaceId, ...(q.active === 'true' ? { releasedAt: null } : q.active === 'false' ? { releasedAt: { not: null } } : {}) },
    orderBy: { placedAt: 'desc' }, take: 200,
  })
  res.json({ holds })
}))

evidenceGovernanceRouter.post('/holds', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const body = parseBody(holdBody, req)
  await owner(user.id, body.workspaceId)
  if (body.jobId) {
    const job = await prisma.job.findFirst({ where: { id: body.jobId, workspaceId: body.workspaceId }, select: { id: true } })
    if (!job) throw new ApiError(404, 'Job not found')
  }
  // Write-ahead: when the external ledger is configured, the placement is recorded there FIRST and
  // the hold is acknowledged only once that succeeded. A restore of PostgreSQL can therefore never
  // lose an acknowledged hold (reconciliation recreates it from the ledger). If the ledger is
  // configured but unreachable the request fails and nothing is created: retry. When no ledger is
  // configured nothing can be deleted at all (the deletion runner requires one), and the runner
  // back-fills such holds into the ledger before it first runs.
  const id = randomUUID()
  const placedAt = new Date()
  const ledger = getApiLedger()
  if (ledger) {
    try {
      await ledger.append({ type: 'HOLD_PLACED', workspaceId: body.workspaceId, holdId: id, scope: body.scope, jobId: body.jobId ?? null, placedBy: user.id, at: placedAt.toISOString() })
    } catch (e) {
      logger.error(`legal hold not placed: the external ledger rejected the write: ${(e as Error).message}`, { service: 'evidence-governance' })
      throw new ApiError(503, 'The legal hold could not be recorded durably in the external ledger, so nothing was changed. Please retry shortly.')
    }
  }
  const hold = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, body.workspaceId)
    return tx.legalHold.create({ data: { id, workspaceId: body.workspaceId, scope: body.scope, jobId: body.jobId ?? null, reason: body.reason, placedByUserId: user.id, placedAt, ledgeredAt: ledger ? new Date() : null } })
  })
  // Files whose deletion has already begun cannot be protected; say so plainly.
  const alreadyDeleting = await prisma.evidenceFile.count({
    where: { workspaceId: body.workspaceId, status: { in: ['DELETING', 'DELETED'] }, ...(body.jobId ? { jobId: body.jobId } : {}) },
  })
  await auditOps({ workspaceId: body.workspaceId, actorUserId: user.id, type: 'evidence.hold.placed', entityType: 'LegalHold', entityId: hold.id, critical: true,
    metadata: { scope: body.scope, jobId: body.jobId ?? null, reason: body.reason, ledgered: Boolean(ledger) } })
  res.status(201).json({ hold, ledgered: Boolean(ledger), filesAlreadyDeletingOrDeleted: alreadyDeleting })
}))

evidenceGovernanceRouter.post('/holds/:id/release', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { id } = parseParams(idParams, req)
  const body = parseBody(scope.extend({ releaseReason: reasonField }).strict(), req)
  await owner(user.id, body.workspaceId)
  const now = new Date()
  const hold = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, body.workspaceId)
    const r = await tx.legalHold.updateMany({ where: { id, workspaceId: body.workspaceId, releasedAt: null }, data: { releasedAt: now, releasedByUserId: user.id, releaseReason: body.releaseReason } })
    if (r.count === 0) {
      const exists = await tx.legalHold.findFirst({ where: { id, workspaceId: body.workspaceId }, select: { id: true } })
      throw new ApiError(exists ? 409 : 404, exists ? 'Hold is already released' : 'Hold not found')
    }
    return tx.legalHold.findFirstOrThrow({ where: { id, workspaceId: body.workspaceId } })
  })
  await auditOps({ workspaceId: body.workspaceId, actorUserId: user.id, type: 'evidence.hold.released', entityType: 'LegalHold', entityId: id, critical: true, metadata: { reason: body.releaseReason } })
  // Release is recorded after the database change: if the ledger write is lost, a restore only makes
  // the hold active again (the protective direction), and the runner back-fills the entry.
  const ledgered = await ledgerRelease(hold, user.id, now)
  res.json({ hold, ledgered })
}))

// ── deletion requests ───────────────────────────────────────────────────────

const requestView = (r: Record<string, unknown>) => {
  const { approvalSeal: _seal, activeFileId: _a, ...rest } = r
  void _seal; void _a
  return rest
}

evidenceGovernanceRouter.get('/deletion-requests', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const q = parseQuery(scope.extend({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTING', 'COMPLETED']).optional() }), req)
  await owner(user.id, q.workspaceId)
  const rows = await prisma.evidenceDeletionRequest.findMany({
    where: { workspaceId: q.workspaceId, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100,
  })
  res.json({ requests: rows.map(requestView) })
}))

evidenceGovernanceRouter.post('/deletion-requests', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const body = parseBody(scope.extend({ fileId: idField, reason: reasonField }).strict(), req)
  await owner(user.id, body.workspaceId)
  requireWorkflow()
  const created = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, body.workspaceId)
    const file = await tx.evidenceFile.findFirst({ where: { id: body.fileId, workspaceId: body.workspaceId }, include: { job: { select: { status: true, completedAt: true } } } })
    if (!file) throw new ApiError(404, 'File not found')
    if (file.status !== 'AVAILABLE') throw new ApiError(409, `File is ${file.status}; only AVAILABLE evidence can be deleted`)
    if (await countActiveHolds(tx, body.workspaceId, file.jobId) > 0) throw new ApiError(409, 'A legal hold covers this file')
    const until = effectiveRetainUntil(file, file.job, await loadPolicy(tx, body.workspaceId))
    if (!until || until > new Date()) throw new ApiError(409, 'Retention is still active for this file')
    return tx.evidenceDeletionRequest.create({
      data: { workspaceId: body.workspaceId, fileId: file.id, jobId: file.jobId, reason: body.reason, requestedByUserId: user.id, activeFileId: file.id },
    })
  }).catch((e: unknown) => { throw isUnique(e) ? new ApiError(409, 'A deletion request is already open for this file') : e })
  await auditOps({ workspaceId: body.workspaceId, actorUserId: user.id, type: 'evidence.deletion.requested', entityType: 'EvidenceFile', entityId: body.fileId, critical: true, metadata: { requestId: created.id, reason: body.reason } })
  res.status(201).json({ request: requestView(created) })
}))

evidenceGovernanceRouter.post('/deletion-requests/:id/approve', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const { id } = parseParams(idParams, req)
  const body = parseBody(scope.extend({ note: z.string().trim().max(2000).optional() }).strict(), req)
  await owner(user.id, body.workspaceId)
  const sealKey = requireWorkflow()
  const now = new Date()
  const approved = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, body.workspaceId)
    const r = await tx.evidenceDeletionRequest.findFirst({ where: { id, workspaceId: body.workspaceId }, include: { file: { include: { job: { select: { status: true, completedAt: true } } } } } })
    if (!r) throw new ApiError(404, 'Request not found')
    if (r.status !== 'REQUESTED') throw new ApiError(409, `Request is ${r.status}`)
    const policy = await loadPolicy(tx, body.workspaceId)
    if (policy.requireDistinctReviewer && r.requestedByUserId === user.id) throw new ApiError(403, 'This workspace requires a different owner to review the request')
    if (r.file.status !== 'AVAILABLE' || !r.file.sha256) throw new ApiError(409, `File is ${r.file.status}`)
    if (await countActiveHolds(tx, body.workspaceId, r.jobId) > 0) throw new ApiError(409, 'A legal hold covers this file')
    const waitDays = policy.deletionWaitDays
    const notBefore = addDays(now, waitDays)
    const until = effectiveRetainUntil(r.file, r.file.job, policy)
    if (!until || until > notBefore) throw new ApiError(409, 'Retention will still be active when the waiting period ends')
    const approvalExpiresAt = addDays(notBefore, APPROVAL_VALID_DAYS)
    const seal = sealApproval(sealKey, {
      requestId: r.id, workspaceId: r.workspaceId, fileId: r.fileId, jobId: r.jobId, fileSha256: r.file.sha256,
      reviewedByUserId: user.id, reviewedAt: now, notBefore, approvalExpiresAt, waitDays,
    })
    const cas = await tx.evidenceDeletionRequest.updateMany({
      where: { id, workspaceId: body.workspaceId, status: 'REQUESTED' },
      data: { status: 'APPROVED', reviewedByUserId: user.id, reviewedAt: now, reviewNote: body.note ?? null, waitDays, notBefore, approvalExpiresAt, approvalSeal: seal },
    })
    if (cas.count === 0) throw new ApiError(409, 'Request changed; reload and try again')
    return tx.evidenceDeletionRequest.findFirstOrThrow({ where: { id, workspaceId: body.workspaceId } })
  })
  await auditOps({ workspaceId: body.workspaceId, actorUserId: user.id, type: 'evidence.deletion.approved', entityType: 'EvidenceFile', entityId: approved.fileId, critical: true,
    metadata: { requestId: id, notBefore: approved.notBefore, waitDays: approved.waitDays } })
  res.json({ request: requestView(approved) })
}))

async function closeRequest(req: Parameters<Parameters<typeof asyncHandler>[0]>[0], res: Parameters<Parameters<typeof asyncHandler>[0]>[1], to: 'REJECTED' | 'CANCELLED') {
  const user = requireUser(req)
  const { id } = parseParams(idParams, req)
  const body = to === 'REJECTED'
    ? parseBody(scope.extend({ note: reasonField }).strict(), req)
    : { ...parseBody(scope.strict(), req), note: undefined as string | undefined }
  await owner(user.id, body.workspaceId)
  const from = to === 'REJECTED' ? ['REQUESTED'] : ['REQUESTED', 'APPROVED']
  const r = await prisma.$transaction(async (tx: Tx) => {
    await lockEvidenceGovernance(tx, body.workspaceId)
    const cas = await tx.evidenceDeletionRequest.updateMany({
      where: { id, workspaceId: body.workspaceId, status: { in: from } },
      data: { status: to, activeFileId: null, ...(to === 'REJECTED' ? { reviewedByUserId: user.id, reviewedAt: new Date(), reviewNote: body.note } : {}) },
    })
    if (cas.count === 0) {
      const ex = await tx.evidenceDeletionRequest.findFirst({ where: { id, workspaceId: body.workspaceId }, select: { status: true } })
      throw new ApiError(ex ? 409 : 404, ex ? `Request is ${ex.status} and cannot be ${to.toLowerCase()}` : 'Request not found')
    }
    return tx.evidenceDeletionRequest.findFirstOrThrow({ where: { id, workspaceId: body.workspaceId } })
  })
  await auditOps({ workspaceId: body.workspaceId, actorUserId: user.id, type: `evidence.deletion.${to.toLowerCase()}`, entityType: 'EvidenceFile', entityId: r.fileId, critical: true, metadata: { requestId: id } })
  res.json({ request: requestView(r) })
}
evidenceGovernanceRouter.post('/deletion-requests/:id/reject', asyncHandler((req, res) => closeRequest(req, res, 'REJECTED')))
evidenceGovernanceRouter.post('/deletion-requests/:id/cancel', asyncHandler((req, res) => closeRequest(req, res, 'CANCELLED')))
