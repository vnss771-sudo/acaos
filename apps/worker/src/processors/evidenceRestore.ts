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
  const state = await primaryState(primary, key, want)
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

  // 5. Stage, verify, re-check the primary, promote, verify.
  const staging = `ws/${file.workspaceId}/job/${file.jobId}/restore/${randomBytes(24).toString('base64url')}`
  assertKeyForJob(staging, file.workspaceId, file.jobId)
  await primary.putBytes(staging, bytes, 'image/jpeg')
  try {
    const staged = await primary.getBytes(staging, BACKUP_MAX_BYTES)
    if (!staged || staged.length !== want.size || sha256Hex(staged) !== want.sha256) throw refuse('staged copy failed verification')
    if ((await primaryState(primary, key, want)) === 'valid') {
      // Someone (or a retry) repaired it while we were working: do not overwrite.
      return { outcome: 'primary_valid', primary: 'valid', activeHolds, dryRun: false }
    }
    await primary.putBytes(key, staged, 'image/jpeg')
    if ((await primaryState(primary, key, want)) !== 'valid') throw refuse('restored object failed verification')
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
): Promise<'valid' | 'missing' | 'corrupted'> {
  let b: Buffer | null
  try { b = await store.getBytes(key, BACKUP_MAX_BYTES) } catch (e) {
    // Only "grown past the cap" proves corruption; a network error must not look like damage.
    if (e instanceof EvidenceObjectTooLargeError) return 'corrupted'
    throw e
  }
  if (!b) return 'missing'
  return b.length === want.size && sha256Hex(b) === want.sha256 ? 'valid' : 'corrupted'
}
