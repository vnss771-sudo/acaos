// Evidence file finalisation and cleanup (C2). The API only records an upload
// intent and hands out a short-lived signed PUT; everything that makes a file
// evidence happens here:
//
//   1. re-check, under the Job row lock, that the job is still ACTIVE, the
//      technician is still assigned and active (same lock the evidence submit,
//      revocation and closeout paths use);
//   2. read the staged object with a hard byte cap, verify the REAL file type and
//      decode it with a pixel limit, then re-encode (drops EXIF/GPS and any
//      appended payload);
//   3. publish the sanitised bytes to the file's pre-allocated final key;
//   4. re-check eligibility under the lock again and flip PENDING -> AVAILABLE with
//      a compare-and-set, so a closeout or revocation that lands mid-processing wins.
//
// Every step is idempotent, so BullMQ retries and duplicate completes are safe.
// Domain code only: the BullMQ Worker is constructed in worker.ts.
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import type { Prisma } from '@prisma/client'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { resolveEvidenceStorage, type EvidenceStorageConfig } from '@acaos/backend-core/lib/evidenceStorageConfig.js'
import {
  getEvidenceStore, assertKeyInWorkspace, EvidenceObjectTooLargeError, type EvidenceObjectStore,
} from '@acaos/backend-core/lib/evidenceStorage.js'
import { sanitizeEvidenceImage, OUTPUT_CONTENT_TYPE } from '@acaos/backend-core/lib/evidenceImage.js'

type Tx = Prisma.TransactionClient
type CopyRow = { id: string; location: string; objectKey: string; status: string; sizeBytes: number | null }
type FileRow = {
  id: string; workspaceId: string; jobId: string; crewMemberId: string
  status: string; contentType: string | null; copies: CopyRow[]
}

export type RejectReason =
  | 'job_missing' | 'job_closed' | 'assignment_revoked' | 'crew_inactive'
  | 'upload_missing' | 'size_mismatch' | 'too_large' | 'corrupt_record'
  | 'empty' | 'unsupported_type' | 'type_mismatch' | 'too_many_pixels' | 'decode_failed'
  | 'abandoned' | 'processing_failed'

export type FinalizeResult =
  | { outcome: 'finalized' }
  | { outcome: 'already_final' }
  | { outcome: 'rejected'; reason: RejectReason }
  | { outcome: 'skipped'; reason: string }

const SERVICE = 'evidence-finalize'

async function loadFile(workspaceId: string, fileId: string): Promise<FileRow | null> {
  return (await prisma.evidenceFile.findFirst({
    where: { id: fileId, workspaceId },
    select: {
      id: true, workspaceId: true, jobId: true, crewMemberId: true, status: true, contentType: true,
      copies: { select: { id: true, location: true, objectKey: true, status: true, sizeBytes: true } },
    },
  })) as FileRow | null
}

/** Must run inside a transaction: takes the Job row lock so closeout/revocation serialise with us. */
async function checkEligibility(tx: Tx, f: FileRow): Promise<RejectReason | null> {
  const rows = (await tx.$queryRaw`
    SELECT "status" FROM "Job" WHERE "id" = ${f.jobId} AND "workspaceId" = ${f.workspaceId} FOR UPDATE`) as Array<{ status: string }>
  if (!rows.length) return 'job_missing'
  if (rows[0].status !== 'ACTIVE') return 'job_closed'
  const assignment = await tx.jobTechnicianAssignment.findFirst({
    where: { workspaceId: f.workspaceId, jobId: f.jobId, crewMemberId: f.crewMemberId }, select: { id: true },
  })
  if (!assignment) return 'assignment_revoked'
  const crew = await tx.opsCrewMember.findFirst({
    where: { id: f.crewMemberId, workspaceId: f.workspaceId, isActive: true }, select: { id: true },
  })
  if (!crew) return 'crew_inactive'
  return null
}

function audit(f: { id: string; workspaceId: string }, type: string, metadata: Record<string, unknown>) {
  void recordAudit({ workspaceId: f.workspaceId, actorUserId: null, type, entityType: 'EvidenceFile', entityId: f.id, metadata })
    .catch((e: Error) => logger.warn(`audit ${type} failed: ${e.message}`, { service: SERVICE }))
}

/**
 * Mark a PENDING file REJECTED and remove its stored objects. The compare-and-set
 * comes FIRST: if another worker already made the file AVAILABLE we must not delete
 * objects that now belong to it.
 */
async function rejectFile(f: FileRow, reason: RejectReason, store: EvidenceObjectStore): Promise<void> {
  const cas = await prisma.evidenceFile.updateMany({
    where: { id: f.id, workspaceId: f.workspaceId, status: 'PENDING' },
    data: { status: 'REJECTED' },
  })
  if (cas.count === 0) return
  audit(f, 'ops.technician.file.rejected', { reason })
  logger.info(`evidence file ${f.id} rejected: ${reason}`, { service: SERVICE })
  await purgeCopies(f.workspaceId, f.copies, store)
}

/** Delete the objects behind these copies; a copy is marked DELETED only once its object is gone. */
async function purgeCopies(workspaceId: string, copies: CopyRow[], store: EvidenceObjectStore): Promise<number> {
  let cleaned = 0
  for (const c of copies) {
    if (c.status === 'DELETED') continue
    try {
      assertKeyInWorkspace(c.objectKey, workspaceId)
      await store.delete(c.objectKey)
      await prisma.evidenceFileCopy.updateMany({
        where: { id: c.id, workspaceId, status: { not: 'DELETED' } },
        data: { status: 'DELETED', deletedAt: new Date() },
      })
      cleaned++
    } catch (e) {
      // Left in place; the sweeper retries copies of REJECTED files until they are gone.
      logger.warn(`could not delete evidence object for copy ${c.id}: ${(e as Error).message}`, { service: SERVICE })
    }
  }
  return cleaned
}

export async function finalizeEvidenceFile(opts: {
  workspaceId: string; fileId: string; lastAttempt?: boolean
  store?: EvidenceObjectStore; config?: EvidenceStorageConfig
}): Promise<FinalizeResult> {
  const state = opts.config ? { enabled: true as const, config: opts.config } : resolveEvidenceStorage()
  // Fail closed: with uploads off or misconfigured the worker touches nothing.
  if (!state.enabled) return { outcome: 'skipped', reason: 'uploads_disabled' }
  const cfg = state.config
  const store = opts.store ?? getEvidenceStore(cfg)

  // A file (and so its workspace) that no longer exists is simply nothing to do.
  const file = await loadFile(opts.workspaceId, opts.fileId)
  if (!file) return { outcome: 'skipped', reason: 'not_found' }
  if (file.status === 'AVAILABLE') return { outcome: 'already_final' }
  if (file.status !== 'PENDING') return { outcome: 'skipped', reason: `status_${file.status.toLowerCase()}` }

  try {
    return await run(file, cfg, store)
  } catch (err) {
    if (opts.lastAttempt) {
      logger.error(`evidence file ${file.id} failed permanently: ${(err as Error).message}`, { service: SERVICE })
      await rejectFile(file, 'processing_failed', store)
      return { outcome: 'rejected', reason: 'processing_failed' }
    }
    throw err // BullMQ retries with backoff
  }
}

async function run(file: FileRow, cfg: EvidenceStorageConfig, store: EvidenceObjectStore): Promise<FinalizeResult> {
  const reject = async (reason: RejectReason): Promise<FinalizeResult> => {
    await rejectFile(file, reason, store)
    return { outcome: 'rejected', reason }
  }

  // 1. Still allowed to proceed? (job open, assignment live, technician active)
  const early = await prisma.$transaction((tx: Tx) => checkEligibility(tx, file))
  if (early) return reject(early)

  const upload = file.copies.find((c: CopyRow) => c.location === 'upload')
  const primary = file.copies.find((c: CopyRow) => c.location === 'primary')
  if (!upload || !primary || upload.sizeBytes == null) return reject('corrupt_record')
  try {
    assertKeyInWorkspace(upload.objectKey, file.workspaceId)
    assertKeyInWorkspace(primary.objectKey, file.workspaceId)
  } catch {
    return reject('corrupt_record')
  }

  // 2. The staged object must exist and be exactly the size that was signed.
  const head = await store.head(upload.objectKey)
  if (!head) return reject('upload_missing')
  if (head.size > cfg.maxUploadBytes) return reject('too_large')
  if (head.size !== upload.sizeBytes) return reject('size_mismatch')

  // 3. Read with a hard cap, then validate the real content and re-encode.
  let bytes: Buffer | null
  try {
    bytes = await store.getBytes(upload.objectKey, cfg.maxUploadBytes)
  } catch (e) {
    if (e instanceof EvidenceObjectTooLargeError) return reject('too_large')
    throw e
  }
  if (!bytes) return reject('upload_missing')
  const clean = await sanitizeEvidenceImage(bytes, { declaredType: file.contentType ?? '', maxPixels: cfg.maxPixels })
  if (!clean.ok) return reject(clean.reason)

  // 4. Publish to the pre-allocated final key (same bytes on a retry: harmless overwrite).
  await store.putBytes(primary.objectKey, clean.bytes, OUTPUT_CONTENT_TYPE)
  const published = await store.head(primary.objectKey)
  if (!published || published.size !== clean.bytes.length) throw new Error('published object failed verification')

  // 5. Commit. Eligibility is re-checked under the lock; a closeout or revocation that
  //    arrived while we were processing wins and nothing becomes AVAILABLE.
  const committed = await prisma.$transaction(async (tx: Tx) => {
    const late = await checkEligibility(tx, file)
    if (late) return { late }
    const now = new Date()
    const cas = await tx.evidenceFile.updateMany({
      where: { id: file.id, workspaceId: file.workspaceId, status: 'PENDING' },
      data: {
        status: 'AVAILABLE', contentType: OUTPUT_CONTENT_TYPE, sizeBytes: clean.bytes.length,
        sha256: clean.sha256, width: clean.width, height: clean.height, finalizedAt: now,
      },
    })
    if (cas.count === 0) return { lost: true }
    await tx.evidenceFileCopy.updateMany({
      where: { id: primary.id, workspaceId: file.workspaceId },
      data: { status: 'VERIFIED', sizeBytes: clean.bytes.length, sha256: clean.sha256, verifiedAt: now },
    })
    return { ok: true }
  }) as { late?: RejectReason; lost?: boolean; ok?: boolean }

  if (committed.late) {
    await store.delete(primary.objectKey).catch(() => {})
    return reject(committed.late)
  }
  if (committed.lost) {
    // Someone else finished or rejected this file while we worked. If it is not
    // AVAILABLE, the object we just published has no owner: remove it.
    const now = await loadFile(file.workspaceId, file.id)
    if (!now || now.status !== 'AVAILABLE') await store.delete(primary.objectKey).catch(() => {})
    return { outcome: 'skipped', reason: 'lost_race' }
  }

  audit(file, 'ops.technician.file.finalized', { sizeBytes: clean.bytes.length, width: clean.width, height: clean.height })
  // 6. The raw upload is no longer needed; if this fails the sweeper removes it.
  await purgeCopies(file.workspaceId, [upload], store)
  return { outcome: 'finalized' }
}

/**
 * Clean up after uploads that never completed or were left behind:
 *  - PENDING files older than the abandonment window are rejected and their objects removed;
 *  - objects still stored for REJECTED files, or the raw upload of AVAILABLE files, are deleted.
 */
export async function sweepAbandonedEvidenceUploads(opts: {
  store?: EvidenceObjectStore; config?: EvidenceStorageConfig; now?: Date; batch?: number
} = {}): Promise<{ rejected: number; copiesCleaned: number; lateUploadsRemoved: number } | { skipped: 'uploads_disabled' }> {
  const state = opts.config ? { enabled: true as const, config: opts.config } : resolveEvidenceStorage()
  if (!state.enabled) return { skipped: 'uploads_disabled' }
  const store = opts.store ?? getEvidenceStore(state.config)
  const batch = opts.batch ?? 100
  const cutoff = new Date((opts.now ?? new Date()).getTime() - state.config.abandonedAfterSeconds * 1000)

  const stale = (await prisma.evidenceFile.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    select: {
      id: true, workspaceId: true, jobId: true, crewMemberId: true, status: true, contentType: true,
      copies: { select: { id: true, location: true, objectKey: true, status: true, sizeBytes: true } },
    },
    orderBy: { createdAt: 'asc' }, take: batch,
  })) as FileRow[]
  let rejected = 0
  for (const f of stale) {
    await rejectFile(f, 'abandoned', store)
    rejected++
  }

  const leftovers = (await prisma.evidenceFileCopy.findMany({
    where: {
      status: { not: 'DELETED' },
      OR: [{ file: { status: 'REJECTED' } }, { location: 'upload', file: { status: 'AVAILABLE' } }],
    },
    select: { id: true, workspaceId: true, location: true, objectKey: true, status: true, sizeBytes: true },
    take: batch,
  })) as Array<CopyRow & { workspaceId: string }>
  let copiesCleaned = 0
  for (const c of leftovers) copiesCleaned += await purgeCopies(c.workspaceId, [c], store)

  // A signed upload URL stays valid for its whole lifetime, even after the file was
  // finalised or rejected and its raw object deleted, so a client could PUT again and
  // recreate an object the database no longer tracks. Once those URLs are certain to
  // have expired, delete the raw keys of recently-closed uploads once more. Deleting a
  // missing object is a no-op, so this is cheap and idempotent.
  const now = opts.now ?? new Date()
  const expiredBy = new Date(now.getTime() - (state.config.presignTtlSeconds + 30) * 1000)
  const recentWindow = new Date(now.getTime() - 6 * 60 * 60 * 1000)
  const closedUploads = (await prisma.evidenceFileCopy.findMany({
    where: { location: 'upload', status: 'DELETED', deletedAt: { gte: recentWindow, lte: expiredBy } },
    select: { workspaceId: true, objectKey: true }, take: batch,
  })) as Array<{ workspaceId: string; objectKey: string }>
  let lateUploadsRemoved = 0
  for (const c of closedUploads) {
    try {
      assertKeyInWorkspace(c.objectKey, c.workspaceId)
      if (await store.head(c.objectKey)) { await store.delete(c.objectKey); lateUploadsRemoved++ }
    } catch (e) {
      logger.warn(`late-upload cleanup failed: ${(e as Error).message}`, { service: SERVICE })
    }
  }
  return { rejected, copiesCleaned, lateUploadsRemoved }
}
