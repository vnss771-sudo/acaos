// Shared rules for evidence retention, legal holds and deletion approval (C4).
// Used by the owner-only API routes and by the deletion runner, so both apply exactly
// the same checks.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { canonicalJson } from './evidenceLedger.js'

type Tx = Prisma.TransactionClient

export const DEFAULT_RETENTION_DAYS = 2555   // seven years
export const DEFAULT_WAIT_DAYS = 7
export const APPROVAL_VALID_DAYS = 30        // an approval not executed this long after its wait ends expires
export const WAIT_REDUCTION_COOLING_OFF_MS = 24 * 3600_000
const DAY = 86_400_000

/**
 * Serialise hold placement/release with deletion start for one workspace. Hold changes
 * and the APPROVED -> EXECUTING transition both take it, so a hold that commits first
 * blocks the deletion, and a deletion that commits first has already left AVAILABLE.
 * (An advisory lock rather than a row lock: it must not interfere with ordinary inserts.)
 */
export async function lockEvidenceGovernance(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'evidence-governance:' + workspaceId}, 0))`
}

// Structural types, so these helpers accept both a PrismaClient and a transaction client
// (and compile against the offline Prisma stub, which has no per-model delegate types).
export type HoldDb = { legalHold: { count(args: { where: Record<string, unknown> }): Promise<number> } }
type PolicyRow = {
  retentionDays: number; startRule: string; deletionWaitDays: number; requireDistinctReviewer: boolean
  pendingWaitDays: number | null; pendingWaitRequestedAt: Date | null; autoDeletionEnabled: boolean
}
export type PolicyDb = { retentionPolicy: { findUnique(args: { where: { workspaceId: string } }): Promise<PolicyRow | null> } }

/** Active (unreleased) holds covering a job: workspace-wide ones and that job's own. */
export async function countActiveHolds(db: HoldDb, workspaceId: string, jobId: string): Promise<number> {
  return db.legalHold.count({
    where: { workspaceId, releasedAt: null, OR: [{ scope: 'WORKSPACE' }, { scope: 'JOB', jobId }] },
  })
}

export type PolicyView = {
  retentionDays: number; startRule: string; deletionWaitDays: number; requireDistinctReviewer: boolean
  pendingWaitDays: number | null; pendingWaitRequestedAt: Date | null; autoDeletionEnabled: boolean
}
export async function loadPolicy(db: PolicyDb, workspaceId: string): Promise<PolicyView> {
  const p = await db.retentionPolicy.findUnique({ where: { workspaceId } })
  return {
    retentionDays: p?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    startRule: p?.startRule ?? 'LATER_OF_UPLOAD_AND_CLOSEOUT',
    deletionWaitDays: p?.deletionWaitDays ?? DEFAULT_WAIT_DAYS,
    requireDistinctReviewer: p?.requireDistinctReviewer ?? false,
    pendingWaitDays: p?.pendingWaitDays ?? null,
    pendingWaitRequestedAt: p?.pendingWaitRequestedAt ?? null,
    autoDeletionEnabled: p?.autoDeletionEnabled ?? false,
  }
}

/**
 * Earliest time a file may be deleted, or null when it cannot be determined (which is
 * treated as "still retained"). The stored per-file retainUntil can only extend this.
 */
export function effectiveRetainUntil(
  file: { finalizedAt: Date | null; retainUntil: Date | null },
  job: { status: string; completedAt: Date | null } | null,
  policy: { retentionDays: number; startRule: string },
): Date | null {
  if (!file.finalizedAt) return null
  const closeout = job && job.status === 'COMPLETE' ? job.completedAt : null
  let start: Date | null
  switch (policy.startRule) {
    case 'UPLOAD': start = file.finalizedAt; break
    case 'JOB_CLOSEOUT': start = closeout; break
    default: start = closeout ? new Date(Math.max(file.finalizedAt.getTime(), closeout.getTime())) : null
  }
  if (!start) return null
  const computed = new Date(start.getTime() + policy.retentionDays * DAY)
  return file.retainUntil && file.retainUntil > computed ? file.retainUntil : computed
}

export type DeletionBlocker = 'not_available' | 'retention_active' | 'legal_hold'

// ── approval seal ───────────────────────────────────────────────────────────
// The approval endpoint seals what was approved with an HMAC under a key only the API
// and the deletion runner hold. The runner refuses a request whose seal does not verify,
// so a row set to APPROVED any other way (SQL, a restored or tampered database) is inert.

export type SealInput = {
  requestId: string; workspaceId: string; fileId: string; jobId: string; fileSha256: string
  reviewedByUserId: string; reviewedAt: Date; notBefore: Date; approvalExpiresAt: Date; waitDays: number
}
export function sealApproval(key: string, i: SealInput): string {
  return createHmac('sha256', key).update(canonicalJson({
    v: 1, requestId: i.requestId, workspaceId: i.workspaceId, fileId: i.fileId, jobId: i.jobId, fileSha256: i.fileSha256,
    reviewedByUserId: i.reviewedByUserId, reviewedAt: i.reviewedAt.toISOString(), notBefore: i.notBefore.toISOString(),
    approvalExpiresAt: i.approvalExpiresAt.toISOString(), waitDays: i.waitDays,
  })).digest('hex')
}
export function verifySeal(key: string, i: SealInput, seal: string | null | undefined): boolean {
  if (!seal) return false
  const want = Buffer.from(sealApproval(key, i), 'hex'); const got = Buffer.from(seal, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

export function addDays(d: Date, days: number): Date { return new Date(d.getTime() + days * DAY) }
