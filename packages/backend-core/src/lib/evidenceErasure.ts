// Controlled workspace erasure (C4). Erasing a workspace must never bypass legal holds,
// retention, or the external deletion ledger. It is allowed only when:
//   - there is no active legal hold, and every hold's placement/release is in the ledger;
//   - every evidence file is DELETED (retention was enforced when each deletion was
//     requested and approved) and no deletion request is still open;
//   - the external ledger confirms each deletion as completed (ledger required);
//   - a WORKSPACE_ERASED entry is appended to the ledger before the rows are removed.
// Only then are the evidence tombstone rows removed with the workspace; the permanent
// record of what was deleted is the ledger plus the FK-free EvidenceDeletionLog.
import type { Prisma } from '@prisma/client'
import type { EvidenceLedger } from './evidenceLedger.js'
import { lockEvidenceGovernance } from './evidenceGovernance.js'

type Tx = Prisma.TransactionClient
// A PrismaClient or a transaction client (see evidenceGovernance.ts): real types, also offline-stub compatible.
type Db = Tx

export type ErasureBlocker =
  | 'deletion_disabled' | 'active_legal_hold' | 'evidence_not_deleted' | 'open_deletion_requests'
  | 'holds_not_ledgered' | 'ledger_unavailable' | 'ledger_unconfirmed'

const ACTIVE = ['REQUESTED', 'APPROVED', 'EXECUTING']

/** The database-only blockers, cheap enough to re-check inside the erasure transaction. */
export async function localErasureBlockers(db: Db, workspaceId: string): Promise<ErasureBlocker[]> {
  const out: ErasureBlocker[] = []
  const [activeHolds, undeleted, open, unledgered] = await Promise.all([
    db.legalHold.count({ where: { workspaceId, releasedAt: null } }),
    db.evidenceFile.count({ where: { workspaceId, status: { not: 'DELETED' } } }),
    db.evidenceDeletionRequest.count({ where: { workspaceId, status: { in: ACTIVE } } }),
    db.legalHold.count({ where: { workspaceId, OR: [{ ledgeredAt: null }, { releasedAt: { not: null }, releaseLedgeredAt: null }] } }),
  ])
  if (activeHolds > 0) out.push('active_legal_hold')
  if (undeleted > 0) out.push('evidence_not_deleted')
  if (open > 0) out.push('open_deletion_requests')
  if (unledgered > 0) out.push('holds_not_ledgered')
  return out
}

export async function hasEvidenceRecords(db: Db, workspaceId: string): Promise<boolean> {
  const [f, h, r] = await Promise.all([
    db.evidenceFile.count({ where: { workspaceId } }), db.legalHold.count({ where: { workspaceId } }), db.evidenceDeletionRequest.count({ where: { workspaceId } }),
  ])
  return f + h + r > 0
}

export async function evaluateWorkspaceErasure(db: Db, workspaceId: string, opts: { workflowEnabled: boolean; ledger: EvidenceLedger | null }): Promise<ErasureBlocker[]> {
  if (!(await hasEvidenceRecords(db, workspaceId))) return []
  if (!opts.workflowEnabled) return ['deletion_disabled']
  const blockers = await localErasureBlockers(db, workspaceId)
  if (!opts.ledger) { blockers.push('ledger_unavailable'); return blockers }
  try {
    const deleted: Array<{ id: string }> = await db.evidenceFile.findMany({ where: { workspaceId, status: 'DELETED' }, select: { id: true } })
    const { states, invalid } = await opts.ledger.fileStates(workspaceId)
    if (invalid.length > 0 || deleted.some((f) => !states.get(f.id)?.completed)) blockers.push('ledger_unconfirmed')
  } catch { blockers.push('ledger_unavailable') }
  return blockers
}

/** Inside the erasure transaction: lock, re-check the local blockers, then remove the evidence rows. */
export async function eraseEvidenceRowsLocked(tx: Tx, workspaceId: string): Promise<{ files: number }> {
  await lockEvidenceGovernance(tx, workspaceId)
  const again = await localErasureBlockers(tx, workspaceId)
  if (again.length > 0) throw Object.assign(new Error(`erasure blocked: ${again.join(',')}`), { erasureBlockers: again })
  await tx.evidenceDeletionRequest.deleteMany({ where: { workspaceId } })
  await tx.evidenceFileCopy.deleteMany({ where: { workspaceId } })
  const files = await tx.evidenceFile.deleteMany({ where: { workspaceId } })
  await tx.legalHold.deleteMany({ where: { workspaceId } })
  return { files: files.count }
}
