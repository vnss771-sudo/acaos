// Independent backup of finalised evidence (C3). For every AVAILABLE file the
// backup worker copies the primary object to a SEPARATE store (R2) and only calls the
// copy VERIFIED after reading it back and matching the SHA-256 and length recorded
// when the file was finalised. Until then the file is not "protected".
//
//   - The database is authoritative. (workspaceId, fileId) is resolved first, the
//     object key must sit under ws/<workspaceId>/job/<jobId>/, and the backup key is
//     derived from the primary row, never from a caller.
//   - This module never deletes anything: not in the primary and not in the backup.
//   - A backup object that already exists with different bytes is an incident; it is
//     reported and left alone, never overwritten.
//   - Retries and duplicate jobs are safe: every step is idempotent and the final
//     transition is a compare-and-set that requires the file to be unchanged.
//
// Durability: finalisation does not enqueue anything the backup depends on. The
// scheduled sweep finds finalised-but-unverified files in the database and queues
// them, so a crash between commit and enqueue only delays the backup.
// Domain code only: the BullMQ Worker is constructed in worker.ts.
import { createHash } from 'node:crypto'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { resolveEvidenceStorage } from '@acaos/backend-core/lib/evidenceStorageConfig.js'
import { resolveEvidenceBackup } from '@acaos/backend-core/lib/evidenceBackupConfig.js'
import {
  getEvidenceStore, getEvidenceBackupStore, assertKeyForJob, EvidenceObjectTooLargeError, type EvidenceObjectStore,
} from '@acaos/backend-core/lib/evidenceStorage.js'

const SERVICE = 'evidence-backup'
/** Hard ceiling for any single read (the largest permitted upload; finalised files are smaller). */
export const BACKUP_MAX_BYTES = 25 * 1024 * 1024
export const BACKUP_RETRY_AFTER_MS = 15 * 60_000
export const UNVERIFIED_ALERT_AFTER_MS = 24 * 3600_000
/** Failure codes that mean the bytes disagree somewhere. These alert immediately. */
export const INTEGRITY_CODES = ['primary_mismatch', 'primary_missing', 'backup_conflict', 'readback_mismatch', 'verify_mismatch', 'verify_missing'] as const

export const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export type ReplicateResult =
  | { outcome: 'verified' }
  | { outcome: 'already_verified' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string }

type FileRow = {
  id: string; workspaceId: string; jobId: string; status: string; sha256: string | null; sizeBytes: number | null
  copies: Array<{ id: string; location: string; objectKey: string; status: string; sha256: string | null; sizeBytes: number | null }>
}

function audit(f: { id: string; workspaceId: string }, type: string, metadata: Record<string, unknown>) {
  void recordAudit({ workspaceId: f.workspaceId, actorUserId: null, type, entityType: 'EvidenceFile', entityId: f.id, metadata })
    .catch((e: Error) => logger.warn(`audit ${type} failed: ${e.message}`, { service: SERVICE }))
}

export async function replicateEvidenceFile(opts: {
  workspaceId: string; fileId: string; lastAttempt?: boolean
  primary?: EvidenceObjectStore; backup?: EvidenceObjectStore
}): Promise<ReplicateResult> {
  // Fail closed: both stores must be configured, independently.
  const backupState = resolveEvidenceBackup()
  const primaryState = resolveEvidenceStorage()
  const backup = opts.backup ?? (backupState.enabled ? getEvidenceBackupStore(backupState.config) : null)
  const primary = opts.primary ?? (primaryState.enabled ? getEvidenceStore(primaryState.config) : null)
  if (!backup) return { outcome: 'skipped', reason: 'backup_disabled' }
  if (!primary) return { outcome: 'skipped', reason: 'storage_disabled' }

  const file = (await prisma.evidenceFile.findFirst({
    where: { id: opts.fileId, workspaceId: opts.workspaceId },
    select: {
      id: true, workspaceId: true, jobId: true, status: true, sha256: true, sizeBytes: true,
      copies: { select: { id: true, location: true, objectKey: true, status: true, sha256: true, sizeBytes: true } },
    },
  })) as FileRow | null
  if (!file) return { outcome: 'skipped', reason: 'not_found' }
  if (file.status !== 'AVAILABLE') return { outcome: 'skipped', reason: `status_${file.status.toLowerCase()}` }

  const prim = file.copies.find((c) => c.location === 'primary')
  if (!prim || prim.status !== 'VERIFIED' || !prim.sha256 || prim.sizeBytes == null || prim.sha256 !== file.sha256) {
    return { outcome: 'skipped', reason: 'primary_not_verified' }
  }
  try { assertKeyForJob(prim.objectKey, file.workspaceId, file.jobId) } catch { return { outcome: 'skipped', reason: 'bad_key' } }

  // The backup row; its key IS the primary key (different bucket), derived here.
  await prisma.evidenceFileCopy.createMany({
    data: [{ workspaceId: file.workspaceId, fileId: file.id, location: 'backup', objectKey: prim.objectKey }],
    skipDuplicates: true,
  })
  const row = (await prisma.evidenceFileCopy.findFirst({
    where: { fileId: file.id, workspaceId: file.workspaceId, location: 'backup' },
    select: { id: true, objectKey: true, status: true },
  })) as { id: string; objectKey: string; status: string } | null
  if (!row || row.objectKey !== prim.objectKey) return { outcome: 'skipped', reason: 'backup_row_mismatch' }
  if (row.status === 'VERIFIED') return { outcome: 'already_verified' }

  const claimed = await prisma.evidenceFileCopy.updateMany({
    where: { id: row.id, workspaceId: file.workspaceId, status: { in: ['PENDING', 'FAILED', 'VERIFYING'] } },
    data: { status: 'VERIFYING', attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: null },
  })
  if (claimed.count === 0) return { outcome: 'already_verified' }

  const fail = async (code: string): Promise<ReplicateResult> => {
    await prisma.evidenceFileCopy.updateMany({
      where: { id: row.id, workspaceId: file.workspaceId, status: 'VERIFYING' },
      data: { status: 'FAILED', lastError: code },
    })
    if ((INTEGRITY_CODES as readonly string[]).includes(code)) {
      logger.error(`evidence backup INTEGRITY incident for file ${file.id}: ${code}`, { service: SERVICE })
      audit(file, 'ops.technician.file.backup_incident', { code })
    } else {
      logger.warn(`evidence backup failed for file ${file.id}: ${code}`, { service: SERVICE })
    }
    return { outcome: 'failed', reason: code }
  }

  try {
    // 1. Read the primary and prove it is still the bytes we recorded.
    let bytes: Buffer | null
    try { bytes = await primary.getBytes(prim.objectKey, BACKUP_MAX_BYTES) } catch (e) {
      if (e instanceof EvidenceObjectTooLargeError) return await fail('primary_mismatch')
      throw e
    }
    if (!bytes) return await fail('primary_missing')
    if (bytes.length !== prim.sizeBytes || sha256Hex(bytes) !== prim.sha256) return await fail('primary_mismatch')

    // 2. Copy, unless the backup already holds an object; then it must be identical.
    let existing: Buffer | null
    try { existing = await backup.getBytes(prim.objectKey, BACKUP_MAX_BYTES) } catch (e) {
      if (e instanceof EvidenceObjectTooLargeError) return await fail('backup_conflict')
      throw e
    }
    if (existing) {
      if (existing.length !== bytes.length || sha256Hex(existing) !== prim.sha256) return await fail('backup_conflict')
    } else {
      await backup.putBytes(prim.objectKey, bytes, 'image/jpeg')
    }

    // 3. Read back what is actually stored and verify length and hash.
    const back = await backup.getBytes(prim.objectKey, BACKUP_MAX_BYTES)
    if (!back || back.length !== prim.sizeBytes || sha256Hex(back) !== prim.sha256) return await fail('readback_mismatch')

    // 4. Mark VERIFIED only if nothing changed underneath us.
    const done = await prisma.evidenceFileCopy.updateMany({
      where: {
        id: row.id, workspaceId: file.workspaceId, status: 'VERIFYING',
        file: {
          status: 'AVAILABLE', sha256: prim.sha256,
          copies: { some: { location: 'primary', objectKey: prim.objectKey, sha256: prim.sha256, status: 'VERIFIED' } },
        },
      },
      data: { status: 'VERIFIED', sizeBytes: back.length, sha256: prim.sha256, verifiedAt: new Date(), lastError: null },
    })
    if (done.count === 0) {
      // Either a concurrent duplicate already verified this copy, or the file changed.
      const now = await prisma.evidenceFileCopy.findFirst({ where: { id: row.id, workspaceId: file.workspaceId }, select: { status: true } })
      if (now?.status === 'VERIFIED') return { outcome: 'already_verified' }
      return { outcome: 'skipped', reason: 'changed_during_backup' }
    }
    audit(file, 'ops.technician.file.backup_verified', { sizeBytes: back.length })
    return { outcome: 'verified' }
  } catch (err) {
    // Network/storage error: record it, then let BullMQ retry (or give up on the last attempt).
    await fail('transient')
    if (opts.lastAttempt) return { outcome: 'failed', reason: 'transient' }
    throw err
  }
}

// ── durable recovery sweep + monitoring ─────────────────────────────────────

export type BackupSweepResult =
  | { skipped: 'backup_disabled' | 'storage_disabled' }
  | {
      queued: number; unverified: number; failed: number; integrityIncidents: number
      oldestUnverifiedSeconds: number; overdue: boolean
    }

/**
 * Find AVAILABLE files whose backup is missing, failed or stuck, queue them, and
 * report lag. A file is "overdue" when it has been unverified for over 24 hours;
 * integrity incidents are reported at error level every run until resolved.
 */
export async function sweepEvidenceBackups(opts: {
  enqueue?: (o: { workspaceId: string; fileId: string }) => Promise<unknown>
  now?: Date; batch?: number
} = {}): Promise<BackupSweepResult> {
  if (!resolveEvidenceBackup().enabled) return { skipped: 'backup_disabled' }
  if (!resolveEvidenceStorage().enabled) return { skipped: 'storage_disabled' }
  const now = opts.now ?? new Date()
  const batch = opts.batch ?? 100
  const retryBefore = new Date(now.getTime() - BACKUP_RETRY_AFTER_MS)
  const enqueue = opts.enqueue ?? (async (o) => (await import('@acaos/backend-core/lib/queues.js')).enqueueEvidenceBackup(o))

  const pending = (await prisma.evidenceFile.findMany({
    where: {
      status: 'AVAILABLE',
      copies: { none: { location: 'backup', status: 'VERIFIED' } },
      OR: [
        { copies: { none: { location: 'backup' } } },
        { copies: { some: { location: 'backup', status: { in: ['PENDING', 'FAILED', 'VERIFYING'] }, OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: retryBefore } }] } } },
      ],
    },
    select: { id: true, workspaceId: true, finalizedAt: true },
    orderBy: { finalizedAt: 'asc' }, take: batch,
  })) as Array<{ id: string; workspaceId: string; finalizedAt: Date | null }>
  let queued = 0
  for (const f of pending) {
    try { await enqueue({ workspaceId: f.workspaceId, fileId: f.id }); queued++ } catch (e) {
      logger.warn(`could not queue backup for file ${f.id}: ${(e as Error).message}`, { service: SERVICE })
    }
  }

  const unverified = await prisma.evidenceFile.count({
    where: { status: 'AVAILABLE', copies: { none: { location: 'backup', status: 'VERIFIED' } } },
  })
  const failed = await prisma.evidenceFileCopy.count({ where: { location: 'backup', status: 'FAILED' } })
  const integrityIncidents = await prisma.evidenceFileCopy.count({
    where: { location: 'backup', lastError: { in: [...INTEGRITY_CODES] }, status: { not: 'VERIFIED' } },
  })
  const oldest = (await prisma.evidenceFile.findFirst({
    where: { status: 'AVAILABLE', finalizedAt: { not: null }, copies: { none: { location: 'backup', status: 'VERIFIED' } } },
    orderBy: { finalizedAt: 'asc' }, select: { finalizedAt: true },
  })) as { finalizedAt: Date | null } | null
  const oldestUnverifiedSeconds = oldest?.finalizedAt ? Math.max(0, Math.floor((now.getTime() - oldest.finalizedAt.getTime()) / 1000)) : 0
  const overdue = oldestUnverifiedSeconds * 1000 > UNVERIFIED_ALERT_AFTER_MS

  if (integrityIncidents > 0) logger.error(`evidence backup: ${integrityIncidents} integrity incident(s) need attention`, { service: SERVICE })
  if (overdue) logger.error(`evidence backup: oldest unverified file is ${oldestUnverifiedSeconds}s old (> 24h)`, { service: SERVICE })
  return { queued, unverified, failed, integrityIncidents, oldestUnverifiedSeconds, overdue }
}

// ── sampled integrity verifier ──────────────────────────────────────────────

export type VerifyResult = { checked: number; ok: number; missing: number; mismatched: number }

/** Re-read a bounded sample of VERIFIED backups for one workspace and re-hash them. */
export async function verifyEvidenceBackups(opts: {
  workspaceId: string; sample?: number; backup?: EvidenceObjectStore
}): Promise<VerifyResult | { skipped: 'backup_disabled' }> {
  const state = resolveEvidenceBackup()
  const backup = opts.backup ?? (state.enabled ? getEvidenceBackupStore(state.config) : null)
  if (!backup) return { skipped: 'backup_disabled' }
  const take = Math.min(Math.max(1, opts.sample ?? 20), 100)

  const rows = (await prisma.evidenceFileCopy.findMany({
    where: { workspaceId: opts.workspaceId, location: 'backup', status: 'VERIFIED' },
    select: { id: true, objectKey: true, sha256: true, sizeBytes: true, file: { select: { id: true, jobId: true } } },
    orderBy: { verifiedAt: 'asc' }, take,   // oldest verification first: every file is eventually re-checked
  })) as Array<{ id: string; objectKey: string; sha256: string | null; sizeBytes: number | null; file: { id: string; jobId: string } }>
  const r: VerifyResult = { checked: 0, ok: 0, missing: 0, mismatched: 0 }
  for (const c of rows) {
    r.checked++
    let code: string | null = null
    try {
      assertKeyForJob(c.objectKey, opts.workspaceId, c.file.jobId)
      const b = await backup.getBytes(c.objectKey, BACKUP_MAX_BYTES)
      if (!b) { r.missing++; code = 'verify_missing' }
      else if (b.length !== c.sizeBytes || sha256Hex(b) !== c.sha256) { r.mismatched++; code = 'verify_mismatch' }
      else {
        r.ok++
        await prisma.evidenceFileCopy.updateMany({ where: { id: c.id, workspaceId: opts.workspaceId }, data: { verifiedAt: new Date() } })
      }
    } catch (e) {
      logger.warn(`backup verification could not read a copy: ${(e as Error).message}`, { service: SERVICE })
    }
    if (code) {
      await prisma.evidenceFileCopy.updateMany({
        where: { id: c.id, workspaceId: opts.workspaceId, status: 'VERIFIED' },
        data: { status: 'FAILED', lastError: code },
      })
      logger.error(`evidence backup verification found ${code} for file ${c.file.id}`, { service: SERVICE })
      audit({ id: c.file.id, workspaceId: opts.workspaceId }, 'ops.technician.file.backup_incident', { code })
    }
  }
  return r
}

// ── manifest ────────────────────────────────────────────────────────────────

export type EvidenceManifest = {
  version: 1
  workspaceId: string
  generatedAt: string
  truncated: boolean
  files: Array<{
    fileId: string; jobId: string; status: string; contentType: string | null
    sizeBytes: number | null; sha256: string | null; retainUntil: string | null
    onLegalHold: boolean; backup: string
  }>
}

/** Inventory for one workspace, generated from the database. Bounded; no keys, contacts or tokens. */
export async function buildEvidenceManifest(workspaceId: string, opts: { limit?: number; now?: Date } = {}): Promise<EvidenceManifest> {
  const limit = Math.min(Math.max(1, opts.limit ?? 5000), 5000)
  const rows = (await prisma.evidenceFile.findMany({
    where: { workspaceId, status: { in: ['AVAILABLE', 'DELETING'] } },
    select: {
      id: true, jobId: true, status: true, contentType: true, sizeBytes: true, sha256: true, retainUntil: true,
      copies: { where: { location: 'backup' }, select: { status: true } },
    },
    orderBy: { id: 'asc' }, take: limit + 1,
  })) as Array<{
    id: string; jobId: string; status: string; contentType: string | null; sizeBytes: number | null; sha256: string | null
    retainUntil: Date | null; copies: Array<{ status: string }>
  }>
  const holds = (await prisma.legalHold.findMany({
    where: { workspaceId, releasedAt: null }, select: { scope: true, jobId: true },
  })) as Array<{ scope: string; jobId: string | null }>
  const wsHold = holds.some((h) => h.scope === 'WORKSPACE')
  const jobHolds = new Set(holds.filter((h) => h.jobId).map((h) => h.jobId as string))
  const page = rows.slice(0, limit)
  return {
    version: 1, workspaceId, generatedAt: (opts.now ?? new Date()).toISOString(), truncated: rows.length > limit,
    files: page.map((f) => ({
      fileId: f.id, jobId: f.jobId, status: f.status, contentType: f.contentType, sizeBytes: f.sizeBytes, sha256: f.sha256,
      retainUntil: f.retainUntil ? f.retainUntil.toISOString() : null,
      onLegalHold: wsHold || jobHolds.has(f.jobId),
      backup: f.copies[0]?.status ?? 'NONE',
    })),
  }
}

/** Write the manifest to the backup store under a new, versioned key (never overwrites). */
export async function storeEvidenceManifest(workspaceId: string, backup: EvidenceObjectStore, manifest?: EvidenceManifest): Promise<{ key: string; sha256: string }> {
  const m = manifest ?? await buildEvidenceManifest(workspaceId)
  if (m.workspaceId !== workspaceId) throw new Error('manifest belongs to another workspace')
  const body = Buffer.from(JSON.stringify(m))
  const key = `ws/${workspaceId}/manifest/${m.generatedAt.replace(/[:.]/g, '-')}.json`
  if (await backup.head(key)) throw new Error('manifest version already exists')
  await backup.putBytes(key, body, 'application/json')
  return { key, sha256: sha256Hex(body) }
}
