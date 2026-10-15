// Unit tests (no database, no network) for evidence governance (C4): configuration that
// fails closed, the approval seal, retention computation, the external ledger (chain,
// MAC, create-only, idempotency) and the immutability probe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEvidenceLedger, resolveDeletionWorkflow, resolveEvidenceDeletion } from '../packages/backend-core/src/lib/evidenceDeletionConfig.ts'
import { resolveEvidenceStorage } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { resolveEvidenceBackup } from '../packages/backend-core/src/lib/evidenceBackupConfig.ts'
import { sealApproval, verifySeal, effectiveRetainUntil, type SealInput } from '../packages/backend-core/src/lib/evidenceGovernance.ts'
import {
  EvidenceLedger, LedgerError, probeLedgerImmutability, assertLedgerTrusted, LedgerNotTrustedError, canonicalJson, semanticKey, type LedgerEntry,
} from '../packages/backend-core/src/lib/evidenceLedger.ts'
import { MemoryEvidenceStore } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { roleCan } from '../apps/api/src/lib/permissions.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const MAC = 'm'.repeat(40), SEAL = 's'.repeat(40)
const PRIMARY = { EVIDENCE_S3_ENDPOINT: 'https://storage.example.test', EVIDENCE_S3_BUCKET: 'acaos-primary', EVIDENCE_S3_ACCESS_KEY_ID: 'PRIMARYKEY' }
const BACKUP = { EVIDENCE_BACKUP_ENDPOINT: `https://${A}.r2.cloudflarestorage.com`, EVIDENCE_BACKUP_BUCKET: 'acaos-backup', EVIDENCE_BACKUP_ACCESS_KEY_ID: 'BACKUPKEY' }
const LEDGER = {
  EVIDENCE_LEDGER_ENABLED: 'true', EVIDENCE_LEDGER_ENDPOINT: `https://${B}.r2.cloudflarestorage.com`, EVIDENCE_LEDGER_BUCKET: 'acaos-ledger',
  EVIDENCE_LEDGER_ACCESS_KEY_ID: 'LEDGERKEY', EVIDENCE_LEDGER_SECRET_ACCESS_KEY: 'ledger-secret-do-not-leak', EVIDENCE_LEDGER_MAC_KEY: MAC,
}
const DELETE = {
  EVIDENCE_DESTRUCTIVE_ENABLED: 'true', EVIDENCE_DELETION_SEAL_KEY: SEAL,
  EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID: 'DELPRIMARY', EVIDENCE_DELETE_PRIMARY_SECRET_ACCESS_KEY: 'delete-primary-secret',
  EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID: 'DELBACKUP', EVIDENCE_DELETE_BACKUP_SECRET_ACCESS_KEY: 'delete-backup-secret',
}
const FULL = { ...PRIMARY, ...BACKUP, ...LEDGER, ...DELETE }
const problems = (s: { enabled: boolean } & Record<string, unknown>) => (s.enabled ? [] : (s.problems as string[]))

// ── configuration ───────────────────────────────────────────────────────────

test('the ledger is off unless flagged, and must be independent of the evidence stores', () => {
  for (const f of [undefined, '', 'false']) assert.equal(resolveEvidenceLedger({ ...LEDGER, EVIDENCE_LEDGER_ENABLED: f }).enabled, false)
  assert.equal(resolveEvidenceLedger({ ...LEDGER, EVIDENCE_LEDGER_ENABLED: 'yes' }).enabled, false)
  assert.equal(resolveEvidenceLedger(LEDGER).enabled, true)
  assert.match(problems(resolveEvidenceLedger({ ...LEDGER, EVIDENCE_LEDGER_ENDPOINT: 'https://evil.test' })).join(';'), /R2/)
  assert.match(problems(resolveEvidenceLedger({ ...LEDGER, EVIDENCE_LEDGER_MAC_KEY: 'short' })).join(';'), /MAC_KEY/)
  assert.match(problems(resolveEvidenceLedger({ ...LEDGER, ...BACKUP, EVIDENCE_BACKUP_ENDPOINT: LEDGER.EVIDENCE_LEDGER_ENDPOINT, EVIDENCE_BACKUP_BUCKET: 'acaos-ledger' })).join(';'), /differ from the backup bucket/)
  assert.match(problems(resolveEvidenceLedger({ ...LEDGER, ...PRIMARY, EVIDENCE_S3_BUCKET: 'acaos-ledger', EVIDENCE_S3_ENDPOINT: LEDGER.EVIDENCE_LEDGER_ENDPOINT })).join(';'), /differ from the primary bucket/)
  assert.match(problems(resolveEvidenceLedger({ ...LEDGER, ...PRIMARY, EVIDENCE_S3_ACCESS_KEY_ID: 'LEDGERKEY' })).join(';'), /credentials must differ/)
  assert.ok(!JSON.stringify(resolveEvidenceLedger({ ...LEDGER, EVIDENCE_LEDGER_ENDPOINT: 'bad' })).includes('ledger-secret-do-not-leak'))
})

test('destructive operations need their own flag and a seal key', () => {
  for (const f of [undefined, 'false']) assert.equal(resolveDeletionWorkflow({ ...DELETE, EVIDENCE_DESTRUCTIVE_ENABLED: f }).enabled, false)
  assert.equal(resolveDeletionWorkflow({ ...DELETE, EVIDENCE_DESTRUCTIVE_ENABLED: '1' }).enabled, false)
  assert.equal(resolveDeletionWorkflow({ ...DELETE, EVIDENCE_DELETION_SEAL_KEY: 'too-short' }).enabled, false)
  assert.equal(resolveDeletionWorkflow(DELETE).enabled, true)
  // the upload and backup flags do not enable it
  assert.equal(resolveDeletionWorkflow({ EVIDENCE_UPLOADS_ENABLED: 'true', EVIDENCE_BACKUP_ENABLED: 'true', EVIDENCE_DELETION_SEAL_KEY: SEAL }).enabled, false)
})

test('the deletion runner needs dedicated, distinct delete credentials and a valid ledger', () => {
  assert.equal(resolveEvidenceDeletion(FULL).enabled, true)
  assert.equal(resolveEvidenceDeletion({ ...FULL, EVIDENCE_DESTRUCTIVE_ENABLED: undefined }).enabled, false)
  for (const k of ['EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID', 'EVIDENCE_DELETE_PRIMARY_SECRET_ACCESS_KEY', 'EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID', 'EVIDENCE_DELETE_BACKUP_SECRET_ACCESS_KEY', 'EVIDENCE_S3_BUCKET', 'EVIDENCE_BACKUP_ENDPOINT']) {
    assert.equal(resolveEvidenceDeletion({ ...FULL, [k]: '' }).enabled, false, k)
  }
  assert.equal(resolveEvidenceDeletion({ ...FULL, EVIDENCE_LEDGER_ENABLED: undefined }).enabled, false, 'no ledger, no deletion')
  // delete tokens must not be the normal write tokens, nor each other
  assert.match(problems(resolveEvidenceDeletion({ ...FULL, EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID: 'PRIMARYKEY' })).join(';'), /differ from EVIDENCE_S3_ACCESS_KEY_ID/)
  assert.match(problems(resolveEvidenceDeletion({ ...FULL, EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID: 'BACKUPKEY' })).join(';'), /differ from EVIDENCE_BACKUP_ACCESS_KEY_ID/)
  assert.match(problems(resolveEvidenceDeletion({ ...FULL, EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID: 'DELPRIMARY' })).join(';'), /must differ/)
  assert.match(problems(resolveEvidenceDeletion({ ...FULL, EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID: 'LEDGERKEY' })).join(';'), /EVIDENCE_LEDGER_ACCESS_KEY_ID/)
  // the unenforced-ledger override is a development aid only
  const dev = resolveEvidenceDeletion({ ...FULL, EVIDENCE_LEDGER_ALLOW_UNENFORCED: 'true' })
  assert.equal(dev.enabled && dev.config.allowUnenforcedLedger, true)
  assert.match(problems(resolveEvidenceDeletion({ ...FULL, EVIDENCE_LEDGER_ALLOW_UNENFORCED: 'true', NODE_ENV: 'production' })).join(';'), /not permitted in production/)
  assert.ok(!JSON.stringify(resolveEvidenceDeletion({ ...FULL, EVIDENCE_S3_BUCKET: '' })).includes('delete-primary-secret'))
})

test('a service that can write or serve evidence is disabled if it holds delete credentials', () => {
  const up = { EVIDENCE_UPLOADS_ENABLED: 'true', EVIDENCE_S3_ENDPOINT: 'https://storage.example.test', EVIDENCE_S3_BUCKET: 'acaos-primary', EVIDENCE_S3_ACCESS_KEY_ID: 'PRIMARYKEY', EVIDENCE_S3_SECRET_ACCESS_KEY: 'x' }
  assert.equal(resolveEvidenceStorage(up).enabled, true)
  const withDelete = resolveEvidenceStorage({ ...up, EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID: 'DELPRIMARY' })
  assert.equal(withDelete.enabled, false); assert.match(problems(withDelete).join(';'), /EVIDENCE_DELETE_/)
  const bk = { EVIDENCE_BACKUP_ENABLED: 'true', EVIDENCE_BACKUP_ENDPOINT: BACKUP.EVIDENCE_BACKUP_ENDPOINT, EVIDENCE_BACKUP_BUCKET: 'acaos-backup', EVIDENCE_BACKUP_ACCESS_KEY_ID: 'BACKUPKEY', EVIDENCE_BACKUP_SECRET_ACCESS_KEY: 'y' }
  assert.equal(resolveEvidenceBackup(bk).enabled, true)
  assert.equal(resolveEvidenceBackup({ ...bk, EVIDENCE_DELETE_BACKUP_SECRET_ACCESS_KEY: 'z' }).enabled, false)
})

test('only owners hold the evidence governance permission', () => {
  assert.equal(roleCan('owner', 'evidence:govern'), true)
  for (const r of ['admin', 'member', null, undefined] as const) assert.equal(roleCan(r, 'evidence:govern'), false, String(r))
})

// ── approval seal ───────────────────────────────────────────────────────────

const seal: SealInput = {
  requestId: 'r1', workspaceId: 'w1', fileId: 'f1', jobId: 'j1', fileSha256: 'c'.repeat(64), reviewedByUserId: 'u1',
  reviewedAt: new Date('2026-01-01T00:00:00Z'), notBefore: new Date('2026-01-08T00:00:00Z'), approvalExpiresAt: new Date('2026-02-07T00:00:00Z'), waitDays: 7,
}
test('the approval seal binds every field and a different key cannot forge it', () => {
  const s = sealApproval(SEAL, seal)
  assert.equal(verifySeal(SEAL, seal, s), true)
  assert.equal(verifySeal('x'.repeat(40), seal, s), false, 'wrong key')
  for (const [k, v] of Object.entries({
    requestId: 'r2', workspaceId: 'w2', fileId: 'f2', jobId: 'j2', fileSha256: 'd'.repeat(64), reviewedByUserId: 'u2', waitDays: 1,
    reviewedAt: new Date('2026-01-02T00:00:00Z'), notBefore: new Date('2026-01-01T00:00:01Z'), approvalExpiresAt: new Date('2027-01-01T00:00:00Z'),
  })) assert.equal(verifySeal(SEAL, { ...seal, [k]: v } as SealInput, s), false, `tampered ${k}`)
  for (const bad of [null, undefined, '', 'zz', s.slice(2), s + '00']) assert.equal(verifySeal(SEAL, seal, bad as string), false)
})

// ── retention ───────────────────────────────────────────────────────────────

test('retention starts per the rule, needs a closed job, and a file-level date can only extend it', () => {
  const up = new Date('2020-01-01T00:00:00Z'), done = new Date('2020-06-01T00:00:00Z')
  const days = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)
  const f = { finalizedAt: up, retainUntil: null as Date | null }
  const closed = { status: 'COMPLETE', completedAt: done }, open = { status: 'ACTIVE', completedAt: null }
  assert.deepEqual(effectiveRetainUntil(f, closed, { retentionDays: 100, startRule: 'LATER_OF_UPLOAD_AND_CLOSEOUT' }), days(done, 100))
  assert.equal(effectiveRetainUntil(f, open, { retentionDays: 100, startRule: 'LATER_OF_UPLOAD_AND_CLOSEOUT' }), null, 'job not closed: cannot be determined = retained')
  assert.deepEqual(effectiveRetainUntil(f, open, { retentionDays: 100, startRule: 'UPLOAD' }), days(up, 100))
  assert.equal(effectiveRetainUntil(f, open, { retentionDays: 100, startRule: 'JOB_CLOSEOUT' }), null)
  assert.deepEqual(effectiveRetainUntil(f, closed, { retentionDays: 100, startRule: 'JOB_CLOSEOUT' }), days(done, 100))
  assert.deepEqual(effectiveRetainUntil({ ...f, retainUntil: days(done, 500) }, closed, { retentionDays: 100, startRule: 'JOB_CLOSEOUT' }), days(done, 500), 'extends')
  assert.deepEqual(effectiveRetainUntil({ ...f, retainUntil: days(done, 5) }, closed, { retentionDays: 100, startRule: 'JOB_CLOSEOUT' }), days(done, 100), 'cannot shorten')
  assert.equal(effectiveRetainUntil({ finalizedAt: null, retainUntil: null }, closed, { retentionDays: 1, startRule: 'UPLOAD' }), null)
  assert.equal(effectiveRetainUntil(f, null, { retentionDays: 1, startRule: 'LATER_OF_UPLOAD_AND_CLOSEOUT' }), null)
})

// ── ledger ──────────────────────────────────────────────────────────────────

const started = (over: Partial<Extract<LedgerEntry, { type: 'FILE_DELETION_STARTED' }>> = {}): LedgerEntry => ({
  type: 'FILE_DELETION_STARTED', workspaceId: 'w1', fileId: 'f1', jobId: 'j1', requestId: 'r1', sha256: 'c'.repeat(64), sizeBytes: 10,
  primaryKey: 'ws/w1/job/j1/final/x', backupKey: 'ws/w1/job/j1/final/x', requestedBy: 'u1', reviewedBy: 'u2',
  approvedAt: '2026-01-01T00:00:00.000Z', notBefore: '2026-01-08T00:00:00.000Z', at: '2026-01-08T00:00:00.000Z', ...over,
})

test('ledger appends are create-only, idempotent, and a conflicting entry is refused', async () => {
  const store = new MemoryEvidenceStore({ immutable: true })
  const l = new EvidenceLedger(store, MAC)
  const first = await l.append(started())
  assert.equal(first.existing, false); assert.equal(first.key, 'v1/ws/w1/file/f1/started')
  const again = await l.append(started({ at: '2027-01-01T00:00:00.000Z' }))   // same logical entry, later time
  assert.equal(again.existing, true)
  await assert.rejects(() => l.append(started({ requestId: 'r2' })), (e: Error) => e instanceof LedgerError && e.code === 'conflict')
  assert.equal((await store.list('v1/ws/w1/seq/')).length, 1, 'the idempotent retry did not extend the chain')
  await l.append({ type: 'FILE_DELETION_COMPLETED', workspaceId: 'w1', fileId: 'f1', requestId: 'r1', at: '2026-01-09T00:00:00.000Z' })
  const { states, invalid } = await l.fileStates('w1')
  assert.deepEqual(invalid, []); assert.equal(states.get('f1')?.completed, true); assert.equal(states.get('f1')?.started?.sha256, 'c'.repeat(64))
})

test('the hash chain is contiguous, linked and verifiable; tampering is detected', async () => {
  const store = new MemoryEvidenceStore()
  const l = new EvidenceLedger(store, MAC)
  for (let i = 1; i <= 4; i++) await l.append(started({ fileId: `f${i}`, primaryKey: `ws/w1/job/j1/final/k${i}` }))
  const ok = await l.verifyChain('w1')
  assert.deepEqual({ ok: ok.ok, entries: ok.entries }, { ok: true, entries: 4 })
  assert.deepEqual(await new EvidenceLedger(store, MAC).verifyChain('other'), { ok: true, entries: 0, problems: [] })

  // delete an entry in the middle -> gap
  const k2 = 'v1/ws/w1/seq/000000000002'
  const saved = store.objects.get(k2)!
  store.objects.delete(k2)
  assert.equal((await l.verifyChain('w1')).ok, false)
  // rewrite an entry's content with a valid-looking but unsigned change -> authentication failure
  store.objects.set(k2, { ...saved, bytes: Buffer.from(saved.bytes.toString().replace('f2', 'fX')) })
  const bad = await l.verifyChain('w1')
  assert.equal(bad.ok, false); assert.match(bad.problems.join(';'), /authentication/)
  // restore it, then re-sign nothing: replace entry 2 with another validly-signed one -> broken link at 3
  store.objects.set(k2, saved)
  assert.equal((await l.verifyChain('w1')).ok, true)
  const other = new EvidenceLedger(new MemoryEvidenceStore(), MAC)
  await other.append(started({ fileId: 'zz' }))
  const forgedValid = (other as unknown as { store: MemoryEvidenceStore }).store.objects.get('v1/ws/w1/seq/000000000001')!
  store.objects.set(k2, forgedValid)
  assert.match((await l.verifyChain('w1')).problems.join(';'), /broken link|wrong seq/)
})

test('an entry forged without the MAC key is rejected and never trusted', async () => {
  const store = new MemoryEvidenceStore()
  const attacker = new EvidenceLedger(store, 'x'.repeat(40))      // has bucket write access, not the MAC key
  await attacker.append(started({ fileId: 'victim' }))
  const l = new EvidenceLedger(store, MAC)
  await assert.rejects(() => l.get('v1/ws/w1/file/victim/started'), (e: Error) => e instanceof LedgerError && e.code === 'invalid')
  const { states, invalid } = await l.fileStates('w1')
  assert.equal(states.size, 0); assert.deepEqual(invalid, ['v1/ws/w1/file/victim/started'])
  // a validly signed entry parked under another file's key is also refused
  const real = new EvidenceLedger(new MemoryEvidenceStore(), MAC)
  await real.append(started({ fileId: 'f9' }))
  const moved = (real as unknown as { store: MemoryEvidenceStore }).store.objects.get('v1/ws/w1/file/f9/started')!
  store.objects.clear(); store.objects.set('v1/ws/w1/file/other/started', moved)
  assert.deepEqual((await l.fileStates('w1')).invalid, ['v1/ws/w1/file/other/started'])
})

test('concurrent appenders get distinct sequence numbers and a valid chain', async () => {
  const store = new MemoryEvidenceStore()
  const ls = [new EvidenceLedger(store, MAC), new EvidenceLedger(store, MAC), new EvidenceLedger(store, MAC)]
  await Promise.all(Array.from({ length: 12 }, (_, i) => ls[i % 3].append(started({ fileId: `c${i}` }))))
  const v = await ls[0].verifyChain('w1')
  assert.deepEqual({ ok: v.ok, entries: v.entries }, { ok: true, entries: 12 })
})

test('hold and erasure entries are recorded and read back', async () => {
  const l = new EvidenceLedger(new MemoryEvidenceStore(), MAC)
  await l.append({ type: 'HOLD_PLACED', workspaceId: 'w1', holdId: 'h1', scope: 'JOB', jobId: 'j1', placedBy: 'u1', at: '2026-01-01T00:00:00.000Z' })
  await l.append({ type: 'HOLD_RELEASED', workspaceId: 'w1', holdId: 'h1', releasedBy: 'u1', at: '2026-02-01T00:00:00.000Z' })
  await l.append({ type: 'HOLD_PLACED', workspaceId: 'w1', holdId: 'h2', scope: 'WORKSPACE', jobId: null, placedBy: 'u1', at: '2026-03-01T00:00:00.000Z' })
  const { holds } = await l.holdStates('w1')
  assert.equal(holds.get('h1')?.released, true); assert.equal(holds.get('h2')?.released, undefined); assert.equal(holds.get('h2')?.placed?.scope, 'WORKSPACE')
  assert.equal(await l.isErased('w1'), false)
  await l.append({ type: 'WORKSPACE_ERASED', workspaceId: 'w1', erasedBy: 'u1', fileCount: 3, at: '2026-04-01T00:00:00.000Z' })
  assert.equal(await l.isErased('w1'), true)
  assert.equal(semanticKey({ type: 'WORKSPACE_ERASED', workspaceId: 'w1', erasedBy: 'u', fileCount: 0, at: '' }), 'v1/ws/w1/erased')
})

test('canonical JSON ignores key order and undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), canonicalJson({ a: [2, { c: undefined, d: 1 }], b: 1 }))
})

// ── immutability probe ──────────────────────────────────────────────────────

test('the probe reports what the credential can actually do, and the gate trusts only "enforced"', async () => {
  const plain = new MemoryEvidenceStore()                              // can overwrite and delete
  const p1 = await probeLedgerImmutability(plain)
  assert.deepEqual({ c: p1.createOnly, o: p1.overwriteDenied, d: p1.deleteDenied, l: p1.level }, { c: true, o: false, d: false, l: 'create_only' })
  assert.equal(plain.objects.size, 0, 'a mutable store is left clean')
  await assert.rejects(() => assertLedgerTrusted(plain), (e: Error) => e instanceof LedgerNotTrustedError && e.probe.level === 'create_only')
  assert.equal((await assertLedgerTrusted(plain, { allowUnenforced: true })).level, 'create_only')

  const locked = new MemoryEvidenceStore({ immutable: true })          // overwrite and delete denied
  const p2 = await probeLedgerImmutability(locked)
  assert.deepEqual({ c: p2.createOnly, o: p2.overwriteDenied, d: p2.deleteDenied, l: p2.level }, { c: true, o: true, d: true, l: 'enforced' })
  assert.equal((await assertLedgerTrusted(locked)).level, 'enforced')
  assert.equal(locked.objects.size, 2, 'each probe leaves its (immutable) probe object')

  // a store that silently ignores overwrites/deletes is also measured as denied
  const silent = new MemoryEvidenceStore()
  silent.putBytes = async (k: string, b: Buffer, c: string) => { if (!silent.objects.has(k)) await MemoryEvidenceStore.prototype.putBytes.call(silent, k, b, c) }
  silent.delete = async () => {}
  assert.equal((await probeLedgerImmutability(silent)).level, 'enforced')

  // a store whose create-only is not enforced is "none"
  const noCond = new MemoryEvidenceStore()
  noCond.putBytesIf = async () => 'written'
  assert.equal((await probeLedgerImmutability(noCond)).level, 'none')
  await assert.rejects(() => assertLedgerTrusted(noCond, { allowUnenforced: true }), LedgerNotTrustedError)
})

test('memory store list() is ordered, bounded and prefix-scoped', async () => {
  const m = new MemoryEvidenceStore()
  for (const k of ['a/3', 'a/1', 'a/2', 'b/1']) await m.putBytes(k, Buffer.from('x'), 'x')
  assert.deepEqual(await m.list('a/'), ['a/1', 'a/2', 'a/3'])
  assert.deepEqual(await m.list('a/', { limit: 2 }), ['a/1', 'a/2'])
  assert.deepEqual(await m.list('a/', { startAfter: 'a/1' }), ['a/2', 'a/3'])
})

// ── helpers with fake database handles (no database) ────────────────────────

import { countActiveHolds, loadPolicy, lockEvidenceGovernance, addDays } from '../packages/backend-core/src/lib/evidenceGovernance.ts'
import { localErasureBlockers, hasEvidenceRecords, evaluateWorkspaceErasure, eraseEvidenceRowsLocked } from '../packages/backend-core/src/lib/evidenceErasure.ts'

test('countActiveHolds asks for workspace-wide and the job\'s own unreleased holds only', async () => {
  let seen: unknown
  const db = { legalHold: { count: async (a: { where: Record<string, unknown> }) => { seen = a.where; return 2 } } }
  assert.equal(await countActiveHolds(db, 'w1', 'j1'), 2)
  assert.deepEqual(seen, { workspaceId: 'w1', releasedAt: null, OR: [{ scope: 'WORKSPACE' }, { scope: 'JOB', jobId: 'j1' }] })
})

test('loadPolicy falls back to the platform defaults (7 years, 7-day wait, no automatic deletion)', async () => {
  const none = await loadPolicy({ retentionPolicy: { findUnique: async () => null } }, 'w1')
  assert.deepEqual({ r: none.retentionDays, d: none.deletionWaitDays, a: none.autoDeletionEnabled, rule: none.startRule }, { r: 2555, d: 7, a: false, rule: 'LATER_OF_UPLOAD_AND_CLOSEOUT' })
  const row = { retentionDays: 3000, startRule: 'UPLOAD', deletionWaitDays: 14, requireDistinctReviewer: true, pendingWaitDays: 3, pendingWaitRequestedAt: new Date(0), autoDeletionEnabled: true }
  const got = await loadPolicy({ retentionPolicy: { findUnique: async () => row } }, 'w1')
  assert.deepEqual({ d: got.deletionWaitDays, p: got.pendingWaitDays, rd: got.requireDistinctReviewer, r: got.retentionDays }, { d: 14, p: 3, rd: true, r: 3000 })
})

test('the governance lock is a per-workspace advisory lock', async () => {
  const calls: unknown[][] = []
  await lockEvidenceGovernance({ $executeRaw: async (...a: unknown[]) => { calls.push(a); return 0 } } as never, 'w1')
  assert.equal(calls.length, 1); assert.match(String((calls[0][0] as string[]).join('?')), /pg_advisory_xact_lock/)
  assert.ok(calls[0].includes('evidence-governance:w1'))
  assert.equal(addDays(new Date('2026-01-01T00:00:00Z'), 7).toISOString(), '2026-01-08T00:00:00.000Z')
})

function fakeDb(c: { files?: number; undeleted?: number; deleted?: string[]; holds?: number; activeHolds?: number; unledgered?: number; requests?: number; open?: number }) {
  return {
    evidenceFile: {
      count: async (a: { where: Record<string, unknown> }) => (a.where.status ? (c.undeleted ?? 0) : (c.files ?? 0)),
      findMany: async () => (c.deleted ?? []).map((id) => ({ id })),
    },
    legalHold: {
      count: async (a: { where: Record<string, unknown> }) => (a.where.OR ? (c.unledgered ?? 0) : a.where.releasedAt === null ? (c.activeHolds ?? 0) : (c.holds ?? 0)),
    },
    evidenceDeletionRequest: { count: async (a: { where: Record<string, unknown> }) => (a.where.status ? (c.open ?? 0) : (c.requests ?? 0)) },
  }
}
const fakeLedger = (completed: string[], invalid: string[] = []) => ({
  fileStates: async () => ({ states: new Map(completed.map((id) => [id, { completed: true }])), invalid }),
}) as unknown as EvidenceLedger

test('erasure blockers: each condition is reported, and a workspace without evidence has none', async () => {
  assert.deepEqual(await localErasureBlockers(fakeDb({}), 'w1'), [])
  assert.deepEqual(await localErasureBlockers(fakeDb({ activeHolds: 1, undeleted: 2, open: 1, unledgered: 1 }), 'w1'),
    ['active_legal_hold', 'evidence_not_deleted', 'open_deletion_requests', 'holds_not_ledgered'])
  assert.equal(await hasEvidenceRecords(fakeDb({}), 'w1'), false)
  for (const c of [{ files: 1 }, { holds: 1 }, { requests: 1 }]) assert.equal(await hasEvidenceRecords(fakeDb(c), 'w1'), true)
  assert.deepEqual(await evaluateWorkspaceErasure(fakeDb({}), 'w1', { workflowEnabled: false, ledger: null }), [], 'no evidence: nothing to block')
})

test('erasure needs the workflow enabled and a ledger that confirms every deletion', async () => {
  const db = fakeDb({ files: 2, deleted: ['f1', 'f2'] })
  assert.deepEqual(await evaluateWorkspaceErasure(db, 'w1', { workflowEnabled: false, ledger: null }), ['deletion_disabled'])
  assert.deepEqual(await evaluateWorkspaceErasure(db, 'w1', { workflowEnabled: true, ledger: null }), ['ledger_unavailable'])
  assert.deepEqual(await evaluateWorkspaceErasure(db, 'w1', { workflowEnabled: true, ledger: fakeLedger(['f1', 'f2']) }), [])
  assert.deepEqual(await evaluateWorkspaceErasure(db, 'w1', { workflowEnabled: true, ledger: fakeLedger(['f1']) }), ['ledger_unconfirmed'])
  assert.deepEqual(await evaluateWorkspaceErasure(db, 'w1', { workflowEnabled: true, ledger: fakeLedger(['f1', 'f2'], ['bad-entry']) }), ['ledger_unconfirmed'])
  const broken = { fileStates: async () => { throw new Error('ledger down') } } as unknown as EvidenceLedger
  assert.deepEqual(await evaluateWorkspaceErasure(db, 'w1', { workflowEnabled: true, ledger: broken }), ['ledger_unavailable'])
  const mixed = await evaluateWorkspaceErasure(fakeDb({ files: 2, undeleted: 1, activeHolds: 1, deleted: ['f1'] }), 'w1', { workflowEnabled: true, ledger: fakeLedger(['f1']) })
  assert.deepEqual(mixed, ['active_legal_hold', 'evidence_not_deleted'])
})

test('the in-transaction erasure re-checks under the lock and removes rows only when clear', async () => {
  const removed: string[] = []
  const tx = (c: Parameters<typeof fakeDb>[0]) => ({
    ...fakeDb(c), $executeRaw: async () => 0,
    evidenceDeletionRequest: { count: async (a: { where: Record<string, unknown> }) => (a.where.status ? (c.open ?? 0) : 0), deleteMany: async () => { removed.push('requests'); return { count: 0 } } },
    evidenceFileCopy: { deleteMany: async () => { removed.push('copies'); return { count: 0 } } },
    evidenceFile: { count: async (a: { where: Record<string, unknown> }) => (a.where.status ? (c.undeleted ?? 0) : 0), deleteMany: async () => { removed.push('files'); return { count: 3 } } },
    legalHold: { count: async (a: { where: Record<string, unknown> }) => (a.where.OR ? 0 : a.where.releasedAt === null ? (c.activeHolds ?? 0) : 0), deleteMany: async () => { removed.push('holds'); return { count: 0 } } },
  })
  await assert.rejects(() => eraseEvidenceRowsLocked(tx({ activeHolds: 1 }) as never, 'w1'), (e: Error & { erasureBlockers?: string[] }) => e.erasureBlockers?.[0] === 'active_legal_hold')
  assert.deepEqual(removed, [], 'nothing removed when a blocker appeared')
  assert.deepEqual(await eraseEvidenceRowsLocked(tx({}) as never, 'w1'), { files: 3 })
  assert.deepEqual(removed, ['requests', 'copies', 'files', 'holds'])
})
