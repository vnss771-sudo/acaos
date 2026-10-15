// Controlled evidence deletion (C4). Executed ONLY by the dedicated deletion runner
// (scripts/evidence-deletion.ts) holding separate, delete-capable credentials; the API
// and the normal worker neither import this module nor hold those credentials.
//
// Flow for one approved request (every step idempotent, so a crash at any point is
// resumed by running the runner again; progress and failures stay visible on the row):
//
//   1. verify the approval seal and that it is due and not expired;
//   2. under the governance lock: no active legal hold, retention elapsed, then
//      APPROVED -> EXECUTING and the file AVAILABLE -> DELETING (compare-and-set);
//   3. append FILE_DELETION_STARTED to the external ledger (before touching any object,
//      so a database restore cannot hide that the deletion was authorised);
//   4. delete the primary object, then the backup object, re-checking holds before each
//      and verifying each is really gone (primary first: if something stops us between
//      the two, a recoverable copy remains);
//   5. append FILE_DELETION_COMPLETED, then mark the copies and the file DELETED, the
//      request COMPLETED, and add the database deletion-log row, in one transaction.
//
// reconcileEvidenceLedger() re-applies deletions recorded in the ledger to a database
// that was restored from an older backup, and recreates/ends legal holds the same way.
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import type { Prisma } from '@prisma/client'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { resolveEvidenceDeletion, type EvidenceDeletionConfig } from '@acaos/backend-core/lib/evidenceDeletionConfig.js'
import { createS3EvidenceStore, assertKeyForJob, type EvidenceObjectStore } from '@acaos/backend-core/lib/evidenceStorage.js'
import { EvidenceLedger, assertLedgerTrusted, LedgerNotTrustedError, type LedgerProbe } from '@acaos/backend-core/lib/evidenceLedger.js'
import {
  lockEvidenceGovernance, countActiveHolds, loadPolicy, effectiveRetainUntil, verifySeal, type SealInput,
} from '@acaos/backend-core/lib/evidenceGovernance.js'

type Tx = Prisma.TransactionClient
const SERVICE = 'evidence-deletion'

export type DeletionStores = { primary: EvidenceObjectStore; backup: EvidenceObjectStore; ledger: EvidenceLedger; ledgerStore: EvidenceObjectStore }

export function buildDeletionStores(cfg: EvidenceDeletionConfig): DeletionStores {
  const ledgerStore = createS3EvidenceStore(cfg.ledger)
  return {
    primary: createS3EvidenceStore(cfg.primary), backup: createS3EvidenceStore(cfg.backup),
    ledger: new EvidenceLedger(ledgerStore, cfg.ledger.macKey), ledgerStore,
  }
}

export type ExecuteResult =
  | { outcome: 'completed' | 'already_completed' }
  | { outcome: 'not_due'; notBefore: Date }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'skipped'; reason: string }

type ReqRow = NonNullable<Awaited<ReturnType<typeof loadRequest>>>
async function loadRequest(requestId: string) {
  return prisma.evidenceDeletionRequest.findUnique({
    where: { id: requestId },
    include: { file: { include: { copies: true, job: { select: { status: true, completedAt: true } } } } },
  })
}

function auditFile(f: { id: string; workspaceId: string }, actor: string | null, type: string, metadata: Record<string, unknown>) {
  void recordAudit({ workspaceId: f.workspaceId, actorUserId: actor, type, entityType: 'EvidenceFile', entityId: f.id, metadata })
    .catch((e: Error) => logger.warn(`audit ${type} failed: ${e.message}`, { service: SERVICE }))
}

async function note(req: { id: string; workspaceId: string }, code: string): Promise<void> {
  await prisma.evidenceDeletionRequest.updateMany({
    where: { id: req.id, workspaceId: req.workspaceId },
    data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: code.slice(0, 64) },
  })
}

function sealInput(r: ReqRow): SealInput | null {
  if (!r.reviewedByUserId || !r.reviewedAt || !r.notBefore || !r.approvalExpiresAt || r.waitDays == null || !r.file.sha256) return null
  return {
    requestId: r.id, workspaceId: r.workspaceId, fileId: r.fileId, jobId: r.jobId, fileSha256: r.file.sha256,
    reviewedByUserId: r.reviewedByUserId, reviewedAt: r.reviewedAt, notBefore: r.notBefore, approvalExpiresAt: r.approvalExpiresAt, waitDays: r.waitDays,
  }
}

/** Mark the copies and file DELETED and the request COMPLETED, writing the database deletion-log row. */
async function finishInDb(tx: Tx, args: {
  workspaceId: string; fileId: string; jobId: string; requestId: string | null; actor: string | null
  sha256: string | null; sizeBytes: number | null; details: Record<string, unknown>; event: string
}): Promise<boolean> {
  const now = new Date()
  const cas = await tx.evidenceFile.updateMany({
    where: { id: args.fileId, workspaceId: args.workspaceId, status: { in: ['AVAILABLE', 'DELETING'] } },
    data: { status: 'DELETED', deletedAt: now },
  })
  await tx.evidenceFileCopy.updateMany({
    where: { fileId: args.fileId, workspaceId: args.workspaceId, status: { not: 'DELETED' } },
    data: { status: 'DELETED', deletedAt: now },
  })
  if (args.requestId) {
    await tx.evidenceDeletionRequest.updateMany({
      where: { id: args.requestId, workspaceId: args.workspaceId, status: { in: ['APPROVED', 'EXECUTING'] } },
      data: { status: 'COMPLETED', completedAt: now, activeFileId: null, lastError: null },
    })
  }
  if (cas.count > 0) {
    await tx.evidenceDeletionLog.create({
      data: {
        workspaceId: args.workspaceId, fileId: args.fileId, jobId: args.jobId, event: args.event,
        actorUserId: args.actor, sha256: args.sha256, sizeBytes: args.sizeBytes, details: args.details as Prisma.InputJsonValue,
      },
    })
  }
  return cas.count > 0
}

export async function executeDeletionRequest(opts: {
  requestId: string; stores: DeletionStores; sealKey: string; now?: Date
}): Promise<ExecuteResult> {
  const now = opts.now ?? new Date()
  const { stores } = opts
  const req = await loadRequest(opts.requestId)
  if (!req) return { outcome: 'skipped', reason: 'not_found' }
  if (req.status === 'COMPLETED') return { outcome: 'already_completed' }
  if (req.status !== 'APPROVED' && req.status !== 'EXECUTING') return { outcome: 'skipped', reason: `status_${req.status.toLowerCase()}` }

  // 1. The approval must be authentic, due, and unexpired.
  const seal = sealInput(req)
  if (!seal || !verifySeal(opts.sealKey, seal, req.approvalSeal)) {
    await note(req, 'seal_invalid')
    logger.error(`deletion request ${req.id} has an invalid approval seal; refusing`, { service: SERVICE })
    auditFile(req.file, null, 'evidence.deletion.seal_invalid', { requestId: req.id })
    return { outcome: 'blocked', reason: 'seal_invalid' }
  }
  if (req.status === 'APPROVED') {
    if (now < req.notBefore!) return { outcome: 'not_due', notBefore: req.notBefore! }
    if (now > req.approvalExpiresAt!) {
      await prisma.evidenceDeletionRequest.updateMany({
        where: { id: req.id, workspaceId: req.workspaceId, status: 'APPROVED' },
        data: { status: 'CANCELLED', activeFileId: null, lastError: 'approval_expired', lastAttemptAt: now },
      })
      auditFile(req.file, null, 'evidence.deletion.expired', { requestId: req.id })
      return { outcome: 'blocked', reason: 'approval_expired' }
    }
  }

  // 2. Start (or resume) under the governance lock.
  const began = await prisma.$transaction(async (tx: Tx): Promise<{ ok: true } | { blocked: string }> => {
    await lockEvidenceGovernance(tx, req.workspaceId)
    const fresh = await tx.evidenceDeletionRequest.findFirst({ where: { id: req.id, workspaceId: req.workspaceId }, select: { status: true } })
    if (!fresh || (fresh.status !== 'APPROVED' && fresh.status !== 'EXECUTING')) return { blocked: 'status_changed' }
    if (await countActiveHolds(tx, req.workspaceId, req.jobId) > 0) return { blocked: 'legal_hold' }
    if (fresh.status === 'APPROVED') {
      const until = effectiveRetainUntil(req.file, req.file.job, await loadPolicy(tx, req.workspaceId))
      if (!until || until > now) return { blocked: 'retention_active' }
      const cas = await tx.evidenceFile.updateMany({
        where: { id: req.fileId, workspaceId: req.workspaceId, status: 'AVAILABLE', sha256: req.file.sha256 },
        data: { status: 'DELETING' },
      })
      if (cas.count === 0) return { blocked: 'file_changed' }
      await tx.evidenceDeletionRequest.update({ where: { id: req.id }, data: { status: 'EXECUTING', executionStartedAt: now } })
    }
    return { ok: true }
  })
  if ('blocked' in began) { await note(req, began.blocked); return { outcome: 'blocked', reason: began.blocked } }

  const f = req.file
  const primaryCopy = f.copies.find((c: { location: string }) => c.location === 'primary')
  if (!primaryCopy) { await note(req, 'no_primary_record'); return { outcome: 'failed', reason: 'no_primary_record' } }
  const key = primaryCopy.objectKey
  const fail = async (code: string): Promise<ExecuteResult> => {
    await note(req, code)
    logger.error(`deletion request ${req.id} stopped (${code}); will resume on the next run`, { service: SERVICE })
    return { outcome: 'failed', reason: code }
  }

  try {
    assertKeyForJob(key, req.workspaceId, req.jobId)
    // 3. Record the authorisation externally BEFORE any object is touched.
    try {
      await stores.ledger.append({
        type: 'FILE_DELETION_STARTED', workspaceId: req.workspaceId, fileId: req.fileId, jobId: req.jobId, requestId: req.id,
        sha256: f.sha256 ?? '', sizeBytes: f.sizeBytes, primaryKey: key, backupKey: key,
        requestedBy: req.requestedByUserId, reviewedBy: req.reviewedByUserId!, approvedAt: req.reviewedAt!.toISOString(),
        notBefore: req.notBefore!.toISOString(), at: now.toISOString(),
      })
    } catch (e) {
      logger.error(`ledger append failed: ${(e as Error).message}`, { service: SERVICE })
      return await fail('ledger_unavailable')
    }

    // 4. Delete primary, then backup; each step re-checks holds and verifies absence.
    for (const [which, store] of [['primary', stores.primary], ['backup', stores.backup]] as const) {
      if (await countActiveHolds(prisma, req.workspaceId, req.jobId) > 0) return await fail('legal_hold')
      try {
        await store.delete(key)
        if (await store.head(key)) return await fail(`${which}_still_present`)
      } catch (e) {
        logger.warn(`${which} delete failed: ${(e as Error).message}`, { service: SERVICE })
        return await fail(`${which}_delete_failed`)
      }
    }
    // Raw-upload leftovers (normally already purged by finalisation).
    for (const c of f.copies as Array<{ location: string; objectKey: string; status: string }>) {
      if (c.location === 'primary' || c.location === 'backup' || c.status === 'DELETED') continue
      try { assertKeyForJob(c.objectKey, req.workspaceId, req.jobId); await stores.primary.delete(c.objectKey) } catch { return await fail('leftover_delete_failed') }
    }

    // 5. Ledger first, then the database.
    try {
      await stores.ledger.append({ type: 'FILE_DELETION_COMPLETED', workspaceId: req.workspaceId, fileId: req.fileId, requestId: req.id, at: new Date().toISOString() })
    } catch { return await fail('ledger_unavailable') }
    await prisma.$transaction((tx: Tx) => finishInDb(tx, {
      workspaceId: req.workspaceId, fileId: req.fileId, jobId: req.jobId, requestId: req.id, actor: req.reviewedByUserId,
      sha256: f.sha256, sizeBytes: f.sizeBytes, event: 'DELETED',
      details: { requestId: req.id, requestedBy: req.requestedByUserId, reviewedBy: req.reviewedByUserId, reason: req.reason },
    }))
    auditFile(f, req.reviewedByUserId, 'evidence.file.deleted', { requestId: req.id })
    return { outcome: 'completed' }
  } catch (e) {
    return await fail(((e as Error).name === 'LedgerError' ? 'ledger_error' : 'unexpected').slice(0, 64))
  }
}

// ── hold ledger sync ────────────────────────────────────────────────────────

/** Append any legal-hold placement/release not yet in the ledger. Returns how many were written. */
export async function syncHoldLedger(ledger: EvidenceLedger): Promise<number> {
  let n = 0
  const holds = await prisma.legalHold.findMany({
    where: { OR: [{ ledgeredAt: null }, { releasedAt: { not: null }, releaseLedgeredAt: null }] },
    take: 500,
  })
  for (const h of holds as Array<{ id: string; workspaceId: string; scope: string; jobId: string | null; placedByUserId: string; placedAt: Date; releasedAt: Date | null; releasedByUserId: string | null; ledgeredAt: Date | null; releaseLedgeredAt: Date | null }>) {
    try {
      if (!h.ledgeredAt) {
        await ledger.append({ type: 'HOLD_PLACED', workspaceId: h.workspaceId, holdId: h.id, scope: h.scope, jobId: h.jobId, placedBy: h.placedByUserId, at: h.placedAt.toISOString() })
        await prisma.legalHold.updateMany({ where: { id: h.id, workspaceId: h.workspaceId }, data: { ledgeredAt: new Date() } }); n++
      }
      if (h.releasedAt && !h.releaseLedgeredAt) {
        await ledger.append({ type: 'HOLD_RELEASED', workspaceId: h.workspaceId, holdId: h.id, releasedBy: h.releasedByUserId ?? 'unknown', at: h.releasedAt.toISOString() })
        await prisma.legalHold.updateMany({ where: { id: h.id, workspaceId: h.workspaceId }, data: { releaseLedgeredAt: new Date() } }); n++
      }
    } catch (e) { logger.warn(`hold ledger sync failed for ${h.id}: ${(e as Error).message}`, { service: SERVICE }) }
  }
  return n
}

// ── reconciliation ──────────────────────────────────────────────────────────

export type ReconcileReport = {
  workspaces: number; retombstoned: number; resumed: number; objectsRemoved: number
  conflicts: Array<{ workspaceId: string; fileId: string; reason: string }>
  holdsRecreated: number; holdsEnded: number; holdsUnrecoverable: number; invalidLedgerEntries: number
}

async function removeObjects(stores: DeletionStores, workspaceId: string, jobId: string, key: string): Promise<number> {
  assertKeyForJob(key, workspaceId, jobId)
  let removed = 0
  for (const s of [stores.primary, stores.backup]) {
    if (await s.head(key)) { await s.delete(key); if (await s.head(key)) throw new Error('object still present after delete'); removed++ }
  }
  return removed
}

/**
 * Make the database agree with the ledger after a restore from an older backup:
 * deletions the ledger records are re-applied (objects removed, rows tombstoned), a
 * deletion that was only started is resumed unless a hold now covers it, and legal
 * holds the ledger knows about are recreated or ended. Never un-deletes anything.
 */
export async function reconcileEvidenceLedger(opts: { stores: DeletionStores; workspaceId?: string }): Promise<ReconcileReport> {
  const { stores } = opts
  const report: ReconcileReport = { workspaces: 0, retombstoned: 0, resumed: 0, objectsRemoved: 0, conflicts: [], holdsRecreated: 0, holdsEnded: 0, holdsUnrecoverable: 0, invalidLedgerEntries: 0 }
  // Workspaces with evidence or holds in the database, PLUS every workspace the ledger knows about that
  // still exists: after a restore the database may have lost all of a workspace's evidence rows and
  // holds, which is exactly when the ledger has to repair it.
  let wsIds: string[]
  if (opts.workspaceId) wsIds = [opts.workspaceId]
  else {
    const fromDb = ((await prisma.workspace.findMany({ where: { OR: [{ evidenceFiles: { some: {} } }, { legalHolds: { some: {} } }] }, select: { id: true } })) as Array<{ id: string }>).map((w) => w.id)
    const fromLedger = await stores.ledger.workspaces()
    const existing = fromLedger.length ? ((await prisma.workspace.findMany({ where: { id: { in: fromLedger } }, select: { id: true } })) as Array<{ id: string }>).map((w) => w.id) : []
    wsIds = [...new Set([...fromDb, ...existing])]
  }

  for (const ws of wsIds) {
    report.workspaces++
    const { states, invalid } = await stores.ledger.fileStates(ws)
    report.invalidLedgerEntries += invalid.length
    for (const [fileId, st] of states) {
      const started = st.started
      if (!started) continue                      // a completed marker without a started one is not actionable
      const file = await prisma.evidenceFile.findFirst({ where: { id: fileId, workspaceId: ws }, include: { copies: true } })
      try {
        // Objects first: they must be gone whatever the database now says.
        if (!file || file.status !== 'DELETED') {
          if (!st.completed && file && (await countActiveHolds(prisma, ws, started.jobId)) > 0) {
            report.conflicts.push({ workspaceId: ws, fileId, reason: 'legal_hold_after_started' }); continue
          }
          report.objectsRemoved += await removeObjects(stores, ws, started.jobId, started.primaryKey)
        }
        if (!file) continue                        // row not in this (older) database: nothing to tombstone
        if (file.status === 'DELETED') continue
        if (!st.completed) {
          await stores.ledger.append({ type: 'FILE_DELETION_COMPLETED', workspaceId: ws, fileId, requestId: started.requestId, at: new Date().toISOString() })
          report.resumed++
        } else report.retombstoned++
        await prisma.$transaction((tx: Tx) => finishInDb(tx, {
          workspaceId: ws, fileId, jobId: started.jobId, requestId: null, actor: null, sha256: file.sha256, sizeBytes: file.sizeBytes,
          event: 'RECONCILED_DELETED', details: { requestId: started.requestId, reason: st.completed ? 'ledger_completed' : 'ledger_started_resumed' },
        }))
        // Close any request row the restore brought back as still open.
        await prisma.evidenceDeletionRequest.updateMany({
          where: { workspaceId: ws, fileId, status: { in: ['REQUESTED', 'APPROVED', 'EXECUTING'] } },
          data: { status: 'COMPLETED', completedAt: new Date(), activeFileId: null, lastError: 'reconciled_from_ledger' },
        })
        auditFile({ id: fileId, workspaceId: ws }, null, 'evidence.file.reconciled_deleted', { requestId: started.requestId })
      } catch (e) {
        logger.error(`reconcile failed for file ${fileId}: ${(e as Error).message}`, { service: SERVICE })
        report.conflicts.push({ workspaceId: ws, fileId, reason: 'reconcile_error' })
      }
    }

    // Legal holds: protective direction first (recreate), then ended-in-ledger holds.
    const { holds, invalid: badHolds } = await stores.ledger.holdStates(ws)
    report.invalidLedgerEntries += badHolds.length
    for (const [holdId, st] of holds) {
      if (!st.placed) continue
      const row = await prisma.legalHold.findFirst({ where: { id: holdId, workspaceId: ws } })
      if (!row && !st.released) {
        try {
          await prisma.legalHold.create({ data: {
            id: holdId, workspaceId: ws, scope: st.placed.scope, jobId: st.placed.jobId,
            reason: 'Recreated from the external ledger after a database restore', placedByUserId: st.placed.placedBy,
            placedAt: new Date(st.placed.at), ledgeredAt: new Date(),
          } })
          report.holdsRecreated++
        } catch { report.holdsUnrecoverable++ }
      } else if (row && !row.releasedAt && st.released) {
        await prisma.legalHold.updateMany({ where: { id: holdId, workspaceId: ws, releasedAt: null }, data: { releasedAt: new Date(), releasedByUserId: 'ledger', releaseReason: 'Release recorded in the external ledger', releaseLedgeredAt: new Date() } })
        report.holdsEnded++
      }
    }
  }
  return report
}

// ── runner cycle ────────────────────────────────────────────────────────────

export type CycleResult =
  | { skipped: 'flag_off' | 'invalid_config'; problems: string[] }
  | { skipped: 'ledger_not_trusted'; probe: LedgerProbe }
  | { skipped: 'ledger_unavailable'; error: string }
  | { skipped: 'holds_not_durable'; holds: number }
  | { reconcile: ReconcileReport; holdsSynced: number; executed: Array<{ requestId: string; result: ExecuteResult }>; stuck: number }

/**
 * One pass of the deletion runner: refuse unless destructive operations are enabled,
 * fully configured, and the ledger is provably immutable; then sync holds, reconcile the
 * database against the ledger, and execute due approved requests (oldest first).
 */
export async function runDeletionCycle(opts: { env?: Record<string, string | undefined>; stores?: DeletionStores; sealKey?: string; allowUnenforcedLedger?: boolean; now?: Date; limit?: number } = {}): Promise<CycleResult> {
  let stores = opts.stores; let sealKey = opts.sealKey; let allowUnenforced = opts.allowUnenforcedLedger ?? false
  if (!stores) {
    const state = resolveEvidenceDeletion(opts.env ?? process.env)
    if (!state.enabled) return { skipped: state.reason, problems: state.problems }
    stores = buildDeletionStores(state.config); sealKey = state.config.sealKey; allowUnenforced = state.config.allowUnenforcedLedger
  }
  if (!sealKey) return { skipped: 'invalid_config', problems: ['seal key missing'] }
  try { await assertLedgerTrusted(stores.ledgerStore, { allowUnenforced }) } catch (e) {
    if (e instanceof LedgerNotTrustedError) return { skipped: 'ledger_not_trusted', probe: e.probe }
    return { skipped: 'ledger_unavailable', error: (e as Error).message.slice(0, 200) }
  }
  const holdsSynced = await syncHoldLedger(stores.ledger)
  // A hold that is not yet in the ledger could still be lost by a database restore, so nothing is
  // deleted until every placement is durable.
  const notDurable = await prisma.legalHold.count({ where: { ledgeredAt: null } })
  if (notDurable > 0) {
    logger.error(`evidence deletion paused: ${notDurable} legal hold(s) are not yet recorded in the external ledger`, { service: SERVICE })
    return { skipped: 'holds_not_durable', holds: notDurable }
  }
  const reconcile = await reconcileEvidenceLedger({ stores })
  const now = opts.now ?? new Date()
  const due = (await prisma.evidenceDeletionRequest.findMany({
    where: { OR: [{ status: 'EXECUTING' }, { status: 'APPROVED', notBefore: { lte: now } }] },
    orderBy: { createdAt: 'asc' }, take: opts.limit ?? 25, select: { id: true },
  })) as Array<{ id: string }>
  const executed: Array<{ requestId: string; result: ExecuteResult }> = []
  for (const r of due) executed.push({ requestId: r.id, result: await executeDeletionRequest({ requestId: r.id, stores, sealKey, now }) })
  // Visibility: requests that have been executing for a long time without finishing.
  const stuck = await prisma.evidenceDeletionRequest.count({ where: { status: 'EXECUTING', lastError: { not: null } } })
  if (stuck > 0) logger.error(`evidence deletion: ${stuck} request(s) are stuck mid-deletion and need attention`, { service: SERVICE })
  return { reconcile, holdsSynced, executed, stuck }
}
