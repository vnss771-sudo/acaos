// Controlled restore of one evidence file from the independent backup (C3).
// Operator-invoked only (scripts/evidence-restore.ts); there is deliberately no HTTP
// route and no queue for it.
//
//   - dry-run is the default and writes nothing: no objects, no database rows.
//   - the caller names workspace, job AND file; all three must match the database.
//   - a primary object that is present and matches the recorded hash is NEVER
//     overwritten ("primary_valid"); only a missing or corrupted one is restored.
//   - executing needs an approver who is an owner of that workspace, a reason, and an
//     audit record written (and awaited) BEFORE any object is changed. If the audit
//     write fails, nothing is restored.
//   - bytes come from the backup, are verified against the SHA-256 and length held in
//     the database, are written to a temporary staging key, read back, and only then
//     promoted to the primary key and read back again.
// Legal holds never block a restore (it adds data back, it removes nothing); they are
// reported so the operator can see them.
import { randomBytes } from 'node:crypto'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { auditCreateData, recordAudit } from '@acaos/backend-core/lib/audit.js'
import {
  getEvidenceStore, getEvidenceBackupStore, assertKeyForJob, EvidenceObjectTooLargeError, type EvidenceObjectStore,
} from '@acaos/backend-core/lib/evidenceStorage.js'
import { resolveEvidenceStorage } from '@acaos/backend-core/lib/evidenceStorageConfig.js'
import { resolveEvidenceBackup } from '@acaos/backend-core/lib/evidenceBackupConfig.js'
import { sha256Hex, BACKUP_MAX_BYTES } from './evidenceBackup.js'

export type RestoreOutcome =
  | 'primary_valid'          // nothing to do; the primary is intact
  | 'would_restore'          // dry-run: primary missing or corrupted
  | 'restored'
  | 'refused'

export type RestoreReport = {
  outcome: RestoreOutcome
  reason?: string
  primary: 'valid' | 'missing' | 'corrupted'
  activeHolds: number
  dryRun: boolean
  sha256?: string
  sizeBytes?: number
}

export class RestoreRefusedError extends Error {
  constructor(public readonly reason: string) { super(`restore refused: ${reason}`); this.name = 'RestoreRefusedError' }
}

export async function restoreEvidenceFile(opts: {
  workspaceId: string; jobId: string; fileId: string
  execute?: boolean              // default false = dry-run
  approvedByUserId?: string      // required to execute: must be an owner of the workspace
  reason?: string                // required to execute
  primary?: EvidenceObjectStore; backup?: EvidenceObjectStore
}): Promise<RestoreReport> {
  const execute = opts.execute === true
  const refuse = (r: string) => new RestoreRefusedError(r)

  const ps = resolveEvidenceStorage(); const bs = resolveEvidenceBackup()
  const primary = opts.primary ?? (ps.enabled ? getEvidenceStore(ps.config) : null)
  const backup = opts.backup ?? (bs.enabled ? getEvidenceBackupStore(bs.config) : null)
  if (!primary) throw refuse('primary storage is not configured')
  if (!backup) throw refuse('backup storage is not configured')

  // 1. The database decides what exists. All three ids must agree.
  const file = (await prisma.evidenceFile.findFirst({
    where: { id: opts.fileId, workspaceId: opts.workspaceId, jobId: opts.jobId },
    select: {
      id: true, workspaceId: true, jobId: true, status: true, sha256: true, sizeBytes: true,
      copies: { select: { location: true, objectKey: true, status: true, sha256: true, sizeBytes: true } },
    },
  })) as null | {
    id: string; workspaceId: string; jobId: string; status: string; sha256: string | null; sizeBytes: number | null
    copies: Array<{ location: string; objectKey: string; status: string; sha256: string | null; sizeBytes: number | null }>
  }
  if (!file) throw refuse('no such file in this workspace and job')
  if (file.status !== 'AVAILABLE') throw refuse(`file is ${file.status}, not AVAILABLE`)
  const prim = file.copies.find((c) => c.location === 'primary')
  const bak = file.copies.find((c) => c.location === 'backup')
  if (!prim || !prim.sha256 || prim.sizeBytes == null || prim.sha256 !== file.sha256) throw refuse('primary record is not verified')
  if (!bak || bak.status !== 'VERIFIED') throw refuse('no VERIFIED backup of this file')
  if (bak.objectKey !== prim.objectKey || bak.sha256 !== prim.sha256) throw refuse('backup record does not match primary record')
  assertKeyForJob(prim.objectKey, file.workspaceId, file.jobId)
  const key = prim.objectKey
  const want = { sha256: prim.sha256, size: prim.sizeBytes }

  const activeHolds = await prisma.legalHold.count({
    where: { workspaceId: file.workspaceId, releasedAt: null, OR: [{ scope: 'WORKSPACE' }, { jobId: file.jobId }] },
  })

  // 2. Never overwrite a valid object.
  const seen = await primaryState(primary, key, want)
  const state = seen.state
  if (state === 'valid') return { outcome: 'primary_valid', primary: state, activeHolds, dryRun: !execute }

  // 3. The backup must itself still be good before we rely on it.
  const bytes = await backup.getBytes(key, BACKUP_MAX_BYTES)
  if (!bytes) throw refuse('backup object is missing')
  if (bytes.length !== want.size || sha256Hex(bytes) !== want.sha256) throw refuse('backup object failed integrity check')

  if (!execute) {
    return { outcome: 'would_restore', primary: state, activeHolds, dryRun: true, sha256: want.sha256, sizeBytes: want.size }
  }

  // 4. Approval: an owner of THIS workspace, with a reason, recorded before we touch anything.
  const denied = async (why: string): Promise<never> => {
    // Denied execute attempts are recorded too (best-effort: the refusal stands either way).
    await recordAudit({
      workspaceId: file.workspaceId, actorUserId: null, type: 'ops.technician.file.restore_refused',
      entityType: 'EvidenceFile', entityId: file.id, metadata: { why, attemptedBy: opts.approvedByUserId ?? null },
    })
    throw refuse(why)
  }
  if (!opts.approvedByUserId) return denied('approval required: --approved-by <owner user id>')
  if (!opts.reason || opts.reason.trim().length < 5) return denied('a reason of at least 5 characters is required')
  const owner = await prisma.membership.findFirst({
    where: { userId: opts.approvedByUserId, workspaceId: file.workspaceId, role: 'owner' }, select: { id: true },
  })
  if (!owner) return denied('approver is not an owner of this workspace')
  const startedAt = Date.now()
  await prisma.auditEvent.create({
    data: auditCreateData({
      workspaceId: file.workspaceId, actorUserId: opts.approvedByUserId, type: 'ops.technician.file.restore_started',
      entityType: 'EvidenceFile', entityId: file.id, metadata: { primaryWas: state, reason: opts.reason.trim(), activeHolds },
    }),
  }) // awaited, not best-effort: if this throws, nothing has been changed

  // 5. Stage, verify, then promote with a CONDITIONAL write: "only if the key is still
  //    absent" (primary was missing) or "only if it still has the ETag I inspected"
  //    (primary was corrupted). An object that appears or changes between inspection and
  //    promotion therefore makes the write fail instead of being overwritten, however
  //    many restores run at once.
  if (state === 'corrupted' && !seen.etag) throw refuse('primary object is damaged in a way that cannot be replaced safely; remove it manually, then re-run')
  const staging = `ws/${file.workspaceId}/job/${file.jobId}/restore/${randomBytes(24).toString('base64url')}`
  assertKeyForJob(staging, file.workspaceId, file.jobId)
  await primary.putBytes(staging, bytes, 'image/jpeg')
  try {
    const staged = await primary.getBytes(staging, BACKUP_MAX_BYTES)
    if (!staged || staged.length !== want.size || sha256Hex(staged) !== want.sha256) throw refuse('staged copy failed verification')
    // The record we are restoring must still be current (not deleted, replaced or un-backed-up).
    const still = await prisma.evidenceFile.findFirst({
      where: {
        id: file.id, workspaceId: file.workspaceId, jobId: file.jobId, status: 'AVAILABLE', sha256: want.sha256,
        copies: { some: { location: 'backup', status: 'VERIFIED', sha256: want.sha256 } },
      },
      select: { id: true },
    })
    if (!still) throw refuse('file record changed during restore')
    const cond = state === 'missing' ? { ifNoneMatch: true as const } : { ifMatch: seen.etag as string }
    const written = await primary.putBytesIf(key, staged, 'image/jpeg', cond)
    if (written === 'precondition_failed') {
      // Something else wrote the key after we looked. If it is now correct we are done;
      // otherwise stop and let the operator re-run against the new state.
      if ((await primaryState(primary, key, want)).state === 'valid') {
        return { outcome: 'primary_valid', primary: 'valid', activeHolds, dryRun: false }
      }
      throw refuse('primary object changed during restore; re-run')
    }
    if ((await primaryState(primary, key, want)).state !== 'valid') throw refuse('restored object failed verification')
  } finally {
    await primary.delete(staging).catch(() => {})
  }

  await prisma.auditEvent.create({
    data: auditCreateData({
      workspaceId: file.workspaceId, actorUserId: opts.approvedByUserId, type: 'ops.technician.file.restore_completed',
      entityType: 'EvidenceFile', entityId: file.id, metadata: { sha256: want.sha256, sizeBytes: want.size, elapsedMs: Date.now() - startedAt },
    }),
  })
  return { outcome: 'restored', primary: state, activeHolds, dryRun: false, sha256: want.sha256, sizeBytes: want.size }
}

async function primaryState(
  store: EvidenceObjectStore, key: string, want: { sha256: string; size: number },
): Promise<{ state: 'valid' | 'missing' | 'corrupted'; etag?: string }> {
  let r: { bytes: Buffer; etag: string } | null
  try { r = await store.getBytesWithEtag(key, BACKUP_MAX_BYTES) } catch (e) {
    // Only "grown past the cap" proves corruption; a network error must not look like damage.
    if (e instanceof EvidenceObjectTooLargeError) return { state: 'corrupted' }
    throw e
  }
  if (!r) return { state: 'missing' }
  return { state: r.bytes.length === want.size && sha256Hex(r.bytes) === want.sha256 ? 'valid' : 'corrupted', etag: r.etag }
}
