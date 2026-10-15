// C3 tests: independent backup, sweep, verifier, manifest and controlled restore.
// Real PostgreSQL and the real processors; two in-memory stores stand in for the
// primary bucket and the backup bucket (no network, no credentials).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  replicateEvidenceFile, sweepEvidenceBackups, verifyEvidenceBackups, buildEvidenceManifest, storeEvidenceManifest, sha256Hex,
} from '../apps/worker/src/processors/evidenceBackup.ts'
import { restoreEvidenceFile, RestoreRefusedError } from '../apps/worker/src/processors/evidenceRestore.ts'
import { MemoryEvidenceStore, newEvidenceKeys } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace } from './helpers/db.ts'

const ACCOUNT = 'b'.repeat(32)
const ENV: Record<string, string> = {
  EVIDENCE_UPLOADS_ENABLED: 'true',
  EVIDENCE_S3_ENDPOINT: 'https://storage.example.test',
  EVIDENCE_S3_BUCKET: 'acaos-evidence-test',
  EVIDENCE_S3_ACCESS_KEY_ID: 'AKIATESTONLY',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'test-only-secret',
  EVIDENCE_BACKUP_ENABLED: 'true',
  EVIDENCE_BACKUP_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  EVIDENCE_BACKUP_BUCKET: 'acaos-evidence-backup-test',
  EVIDENCE_BACKUP_ACCESS_KEY_ID: 'R2TESTONLY',
  EVIDENCE_BACKUP_SECRET_ACCESS_KEY: 'r2-test-only-secret',
}
const saved: Record<string, string | undefined> = {}
let primary: MemoryEvidenceStore
let backup: MemoryEvidenceStore

before(() => { for (const k of Object.keys(ENV)) saved[k] = process.env[k] })
after(async () => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  await disconnect()
})
beforeEach(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  primary = new MemoryEvidenceStore(); backup = new MemoryEvidenceStore()
})

// ── fixtures ────────────────────────────────────────────────────────────────

let n = 0
async function world(email: string) {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: `E${++n}`, fullName: 'Tech', role: 'TECH' } })
  return { owner, ws: workspace, job, crew }
}
type World = Awaited<ReturnType<typeof world>>

/** A finalised file: AVAILABLE, with a VERIFIED primary copy whose bytes are in the primary store. */
async function available(w: World, bytes = Buffer.from(`photo-${randomUUID()}`), over: { finalizedAt?: Date } = {}) {
  const keys = newEvidenceKeys(w.ws.id, w.job.id)
  const sha = sha256Hex(bytes)
  primary.objects.set(keys.primaryKey, { bytes, contentType: 'image/jpeg' })
  const file = await prisma.evidenceFile.create({
    data: {
      workspaceId: w.ws.id, jobId: w.job.id, crewMemberId: w.crew.id, submissionId: randomUUID(), status: 'AVAILABLE',
      contentType: 'image/jpeg', sizeBytes: bytes.length, sha256: sha, finalizedAt: over.finalizedAt ?? new Date(),
    },
  })
  await prisma.evidenceFileCopy.createMany({ data: [{
    workspaceId: w.ws.id, fileId: file.id, location: 'primary', objectKey: keys.primaryKey, status: 'VERIFIED',
    sizeBytes: bytes.length, sha256: sha, verifiedAt: new Date(),
  }] })
  return { file, key: keys.primaryKey, bytes, sha }
}
const rep = (w: World, fileId: string, extra: Record<string, unknown> = {}) =>
  replicateEvidenceFile({ workspaceId: w.ws.id, fileId, primary, backup, ...extra })
const backupRow = (fileId: string) => prisma.evidenceFileCopy.findFirstOrThrow({ where: { fileId, location: 'backup' } })

// ── replication ─────────────────────────────────────────────────────────────

test('replicates a finalised file, verifies it by read-back, and never deletes or rewrites the primary', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'verified' })
  const row = await backupRow(f.file.id)
  assert.equal(row.status, 'VERIFIED'); assert.equal(row.sha256, f.sha); assert.equal(row.sizeBytes, f.bytes.length)
  assert.equal(row.objectKey, f.key); assert.equal(row.attempts, 1); assert.equal(row.lastError, null); assert.ok(row.verifiedAt)
  assert.deepEqual(backup.objects.get(f.key)?.bytes, f.bytes)
  assert.ok(!primary.calls.includes('putBytes') && !primary.calls.includes('delete'), 'primary is only read')
  assert.ok(!backup.calls.includes('delete'), 'the backup path has no delete')
  // duplicate job: nothing more happens
  const putsBefore = backup.calls.filter((c) => c === 'putBytes').length
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'already_verified' })
  assert.equal(backup.calls.filter((c) => c === 'putBytes').length, putsBefore)
})

test('backups are off by default and fail closed: nothing is read or written', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  for (const patch of [{ EVIDENCE_BACKUP_ENABLED: undefined }, { EVIDENCE_BACKUP_ENABLED: 'false' }, { EVIDENCE_BACKUP_BUCKET: ENV.EVIDENCE_S3_BUCKET, EVIDENCE_BACKUP_ENDPOINT: ENV.EVIDENCE_S3_ENDPOINT }]) {
    Object.assign(process.env, ENV)
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    // no injected stores: configuration alone decides
    const r = await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.file.id })
    assert.deepEqual(r, { outcome: 'skipped', reason: 'backup_disabled' })
    assert.deepEqual(await sweepEvidenceBackups({ enqueue: async () => assert.fail('must not queue') }), { skipped: 'backup_disabled' })
  }
  assert.equal(await prisma.evidenceFileCopy.count({ where: { location: 'backup' } }), 0)
  assert.equal(primary.calls.length + backup.calls.length, 0)
})

test('the file is resolved by (workspace, file) in the database before any object is touched', async () => {
  const a = await world('a@example.test'); const b = await world('b@example.test')
  const f = await available(a)
  assert.deepEqual(await rep(b, f.file.id), { outcome: 'skipped', reason: 'not_found' })
  assert.deepEqual(await replicateEvidenceFile({ workspaceId: a.ws.id, fileId: 'nonexistent', primary, backup }), { outcome: 'skipped', reason: 'not_found' })
  assert.equal(primary.calls.length + backup.calls.length, 0)
  assert.equal(await prisma.evidenceFileCopy.count({ where: { location: 'backup' } }), 0)
})

test('only AVAILABLE files with a verified primary are backed up', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  for (const status of ['PENDING', 'REJECTED']) {
    await prisma.evidenceFile.update({ where: { id: f.file.id }, data: { status } })
    assert.equal((await rep(w, f.file.id)).outcome, 'skipped')
  }
  await prisma.evidenceFile.update({ where: { id: f.file.id }, data: { status: 'AVAILABLE' } })
  await prisma.evidenceFileCopy.updateMany({ where: { fileId: f.file.id, location: 'primary' }, data: { status: 'PENDING', verifiedAt: null } })
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'skipped', reason: 'primary_not_verified' })
  assert.equal(backup.calls.length, 0)
})

test('a key outside the exact job prefix is refused (no replication, no write)', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  await prisma.$executeRaw`UPDATE "EvidenceFileCopy" SET "objectKey" = ${`ws/${w.ws.id}/job/other-job/final/abc`} WHERE "fileId" = ${f.file.id}`
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'skipped', reason: 'bad_key' })
  assert.equal(backup.calls.length, 0)
})

test('a primary that no longer matches its recorded hash is an incident and is not copied', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  primary.objects.set(f.key, { bytes: Buffer.from('tampered'), contentType: 'image/jpeg' })
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'failed', reason: 'primary_mismatch' })
  assert.equal(backup.objects.size, 0)
  const row = await backupRow(f.file.id)
  assert.equal(row.status, 'FAILED'); assert.equal(row.lastError, 'primary_mismatch')
  primary.objects.delete(f.key)
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'failed', reason: 'primary_missing' })
})

test('an existing backup object with different bytes is an incident and is never overwritten', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  const foreign = Buffer.from('someone else wrote this')
  backup.objects.set(f.key, { bytes: foreign, contentType: 'image/jpeg' })
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'failed', reason: 'backup_conflict' })
  assert.deepEqual(backup.objects.get(f.key)?.bytes, foreign)
  assert.ok(!backup.calls.includes('putBytes'))
  assert.equal((await backupRow(f.file.id)).lastError, 'backup_conflict')
  // an identical object already there (a retried copy) is simply verified
  backup.objects.set(f.key, { bytes: f.bytes, contentType: 'image/jpeg' })
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'verified' })
})

test('a corrupted or short write is caught by the read-back and never marked VERIFIED', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  for (const corrupt of [(b: Buffer) => Buffer.concat([b, Buffer.from('x')]), (b: Buffer) => b.subarray(0, b.length - 2), (b: Buffer) => Buffer.from(b.map((x) => x ^ 1))]) {
    backup.objects.clear()
    backup.onPut = (key) => { const o = backup.objects.get(key)!; o.bytes = corrupt(o.bytes) }
    // the corrupted object now exists, so a retry classifies it as a conflict rather than overwriting it
    const r = await rep(w, f.file.id)
    assert.equal(r.outcome, 'failed'); assert.equal((r as { reason: string }).reason, 'readback_mismatch')
    assert.notEqual((await backupRow(f.file.id)).status, 'VERIFIED')
    assert.equal((await rep(w, f.file.id)).outcome, 'failed')
  }
})

test('storage failures are recorded and retried; the last attempt reports failure instead of throwing', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  backup.failNext = { op: 'putBytes', times: 1 }
  await assert.rejects(() => rep(w, f.file.id), /injected putBytes failure/)
  let row = await backupRow(f.file.id)
  assert.equal(row.status, 'FAILED'); assert.equal(row.lastError, 'transient'); assert.equal(row.attempts, 1)
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'verified' })
  row = await backupRow(f.file.id)
  assert.equal(row.status, 'VERIFIED'); assert.equal(row.attempts, 2); assert.equal(row.lastError, null)

  const g = await available(w)
  backup.failNext = { op: 'putBytes', times: 1 }
  assert.deepEqual(await rep(w, g.file.id, { lastAttempt: true }), { outcome: 'failed', reason: 'transient' })
  primary.failNext = { op: 'getBytes', times: 1 }
  await assert.rejects(() => rep(w, g.file.id), /injected getBytes failure/)
  assert.equal((await backupRow(g.file.id)).status, 'FAILED')
})

test('a stale worker cannot mark a file VERIFIED after the file changed underneath it', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  backup.onPut = async () => {
    // while the copy is in flight, the file record is replaced (e.g. re-finalised with new bytes)
    await prisma.evidenceFile.update({ where: { id: f.file.id }, data: { sha256: sha256Hex(Buffer.from('new')) } })
  }
  assert.deepEqual(await rep(w, f.file.id), { outcome: 'skipped', reason: 'changed_during_backup' })
  assert.notEqual((await backupRow(f.file.id)).status, 'VERIFIED')

  // the same when the file stops being AVAILABLE mid-copy
  const g = await available(w)
  backup.onPut = async () => { await prisma.evidenceFile.update({ where: { id: g.file.id }, data: { status: 'DELETING' } }) }
  assert.equal((await rep(w, g.file.id)).outcome, 'skipped')
  assert.notEqual((await backupRow(g.file.id)).status, 'VERIFIED')
})

test('duplicate and concurrent jobs converge on one VERIFIED copy', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  const results = await Promise.all([rep(w, f.file.id), rep(w, f.file.id), rep(w, f.file.id)])
  assert.ok(results.every((r) => ['verified', 'already_verified'].includes(r.outcome)), JSON.stringify(results))
  assert.equal(await prisma.evidenceFileCopy.count({ where: { fileId: f.file.id, location: 'backup' } }), 1)
  assert.equal((await backupRow(f.file.id)).status, 'VERIFIED')
  assert.deepEqual(backup.objects.get(f.key)?.bytes, f.bytes)
})

test('a legal hold does not stop backup, and nothing is ever deleted', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  await prisma.legalHold.create({ data: { workspaceId: w.ws.id, scope: 'JOB', jobId: w.job.id, reason: 'dispute', placedByUserId: w.owner.id } })
  assert.equal((await rep(w, f.file.id)).outcome, 'verified')
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: f.file.id } })).status, 'AVAILABLE')
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key))
})

// ── database constraints added by the C3 migration ──────────────────────────

test('the backup state constraints hold', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  const base = { workspaceId: w.ws.id, fileId: f.file.id, location: 'backup' }
  await assert.rejects(() => prisma.evidenceFileCopy.create({ data: { ...base, objectKey: `ws/${w.ws.id}/job/${w.job.id}/upload/x` } }), undefined, 'backup key must be a final key')
  const ok = await prisma.evidenceFileCopy.create({ data: { ...base, objectKey: f.key, status: 'VERIFYING' } })
  await assert.rejects(() => prisma.evidenceFileCopy.update({ where: { id: ok.id }, data: { attempts: -1 } }))
  await assert.rejects(() => prisma.evidenceFileCopy.update({ where: { id: ok.id }, data: { lastError: 'x'.repeat(65) } }))
  await assert.rejects(() => prisma.evidenceFileCopy.update({ where: { id: ok.id }, data: { status: 'VERIFIED' } }), undefined, 'VERIFIED still needs hash, size and time')
})

// ── durable recovery sweep and monitoring ───────────────────────────────────

test('the sweep finds finalised-but-unverified files in the database and reports lag', async () => {
  const w = await world('a@example.test')
  const now = new Date('2026-10-20T00:00:00Z')
  const old = await available(w, undefined, { finalizedAt: new Date(now.getTime() - 30 * 3600_000) })
  const fresh = await available(w, undefined, { finalizedAt: new Date(now.getTime() - 60_000) })
  const done = await available(w)
  await rep(w, done.file.id)
  const queued: string[] = []
  const r = await sweepEvidenceBackups({ now, enqueue: async (o) => { queued.push(o.fileId) } })
  assert.deepEqual(queued.sort(), [old.file.id, fresh.file.id].sort())
  assert.ok('queued' in r)
  if ('queued' in r) {
    assert.equal(r.queued, 2); assert.equal(r.unverified, 2); assert.equal(r.overdue, true)
    assert.ok(r.oldestUnverifiedSeconds >= 30 * 3600 - 1)
  }
})

test('the sweep waits before retrying a file that was just attempted, then retries it', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  backup.failNext = { op: 'putBytes', times: 1 }
  await assert.rejects(() => rep(w, f.file.id))
  const queued: string[] = []
  const enqueue = async (o: { fileId: string }) => { queued.push(o.fileId) }
  await sweepEvidenceBackups({ enqueue })
  assert.deepEqual(queued, [], 'attempted moments ago')
  await sweepEvidenceBackups({ enqueue, now: new Date(Date.now() + 20 * 60_000) })
  assert.deepEqual(queued, [f.file.id])
})

test('integrity incidents are counted every run until resolved', async () => {
  const w = await world('a@example.test')
  const f = await available(w)
  backup.objects.set(f.key, { bytes: Buffer.from('foreign'), contentType: 'image/jpeg' })
  await rep(w, f.file.id)
  const r = await sweepEvidenceBackups({ enqueue: async () => {} })
  assert.ok('integrityIncidents' in r && r.integrityIncidents === 1 && r.failed === 1)
})

test('a queueing failure does not stop the sweep', async () => {
  const w = await world('a@example.test')
  await available(w); await available(w)
  const r = await sweepEvidenceBackups({ enqueue: async () => { throw new Error('redis down') } })
  assert.ok('queued' in r && r.queued === 0 && r.unverified === 2)
})

// ── sampled verifier ────────────────────────────────────────────────────────

test('the verifier re-hashes backups and flags missing or altered copies', async () => {
  const w = await world('a@example.test')
  const files = [await available(w), await available(w), await available(w)]
  for (const f of files) await rep(w, f.file.id)
  backup.objects.get(files[1].key)!.bytes = Buffer.from('bit rot')
  backup.objects.delete(files[2].key)
  const r = await verifyEvidenceBackups({ workspaceId: w.ws.id, backup })
  assert.deepEqual(r, { checked: 3, ok: 1, missing: 1, mismatched: 1 })
  assert.equal((await backupRow(files[0].file.id)).status, 'VERIFIED')
  assert.equal((await backupRow(files[1].file.id)).lastError, 'verify_mismatch')
  assert.equal((await backupRow(files[2].file.id)).lastError, 'verify_missing')
  assert.ok(!backup.calls.includes('delete'))
  // flagged copies are no longer VERIFIED, so the file is "unprotected" again
  const sweep = await sweepEvidenceBackups({ enqueue: async () => {}, now: new Date(Date.now() + 3600_000) })
  assert.ok('unverified' in sweep && sweep.unverified === 2 && sweep.integrityIncidents === 2)
})

test('the verifier is workspace-scoped and bounded', async () => {
  const a = await world('a@example.test'); const b = await world('b@example.test')
  const fa = await available(a); const fb = await available(b)
  await rep(a, fa.file.id); await rep(b, fb.file.id)
  backup.objects.get(fb.key)!.bytes = Buffer.from('rot')
  assert.deepEqual(await verifyEvidenceBackups({ workspaceId: a.ws.id, backup }), { checked: 1, ok: 1, missing: 0, mismatched: 0 })
  assert.equal((await verifyEvidenceBackups({ workspaceId: a.ws.id, backup, sample: 100000 }) as { checked: number }).checked, 1)
  delete process.env.EVIDENCE_BACKUP_ENABLED
  assert.deepEqual(await verifyEvidenceBackups({ workspaceId: a.ws.id }), { skipped: 'backup_disabled' })
})

// ── manifest ────────────────────────────────────────────────────────────────

test('the manifest is a workspace-scoped inventory without keys, contacts or secrets', async () => {
  const a = await world('a@example.test'); const b = await world('b@example.test')
  const fa = await available(a); await available(b)
  await rep(a, fa.file.id)
  await prisma.legalHold.create({ data: { workspaceId: a.ws.id, scope: 'WORKSPACE', reason: 'x', placedByUserId: a.owner.id } })
  const m = await buildEvidenceManifest(a.ws.id)
  assert.equal(m.files.length, 1); assert.equal(m.workspaceId, a.ws.id); assert.equal(m.truncated, false)
  assert.deepEqual(
    { id: m.files[0].fileId, sha: m.files[0].sha256, backup: m.files[0].backup, hold: m.files[0].onLegalHold },
    { id: fa.file.id, sha: fa.sha, backup: 'VERIFIED', hold: true },
  )
  const text = JSON.stringify(m)
  assert.ok(!text.includes('ws/') && !text.includes(a.owner.email ?? 'no-email') && !/secret|token|password/i.test(text))
  assert.equal(JSON.stringify(m).includes(b.ws.id), false)
  assert.equal((await buildEvidenceManifest(a.ws.id, { limit: 1 })).truncated, false)
})

test('manifests are stored under versioned keys and never overwrite', async () => {
  const w = await world('a@example.test')
  const f = await available(w); await rep(w, f.file.id)
  const m1 = await buildEvidenceManifest(w.ws.id, { now: new Date('2026-10-20T01:00:00Z') })
  const s1 = await storeEvidenceManifest(w.ws.id, backup, m1)
  assert.match(s1.key, new RegExp(`^ws/${w.ws.id}/manifest/2026-10-20T01-00-00-000Z\\.json$`))
  assert.equal(sha256Hex(backup.objects.get(s1.key)!.bytes), s1.sha256)
  await assert.rejects(() => storeEvidenceManifest(w.ws.id, backup, m1), /already exists/)
  const other = await world('b@example.test')
  await assert.rejects(() => storeEvidenceManifest(other.ws.id, backup, m1), /another workspace/)
})

// ── restore ─────────────────────────────────────────────────────────────────

async function backedUp(w: World) {
  const f = await available(w)
  await rep(w, f.file.id)
  return f
}
const restore = (w: World, f: { file: { id: string } }, extra: Record<string, unknown> = {}) =>
  restoreEvidenceFile({ workspaceId: w.ws.id, jobId: w.job.id, fileId: f.file.id, primary, backup, ...extra })
const refused = (p: Promise<unknown>, m: RegExp) => assert.rejects(p, (e: Error) => e instanceof RestoreRefusedError && m.test(e.message))
const auditTypes = async (w: World) =>
  (await prisma.auditEvent.findMany({ where: { workspaceId: w.ws.id, type: { startsWith: 'ops.technician.file.restore' } }, orderBy: { createdAt: 'asc' } })).map((e: { type: string }) => e.type)

test('dry-run is the default: it reports a missing primary and changes nothing', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  primary.objects.delete(f.key)
  const writes = () => primary.calls.filter((c) => c === 'putBytes' || c === 'delete').length
  const r = await restore(w, f)
  assert.equal(r.outcome, 'would_restore'); assert.equal(r.primary, 'missing'); assert.equal(r.dryRun, true); assert.equal(r.sha256, f.sha)
  assert.equal(primary.objects.size, 0); assert.equal(writes(), 0)
  assert.deepEqual(await auditTypes(w), [], 'a dry-run writes no audit rows either')
  // a corrupted primary is distinguished from a missing one
  primary.objects.set(f.key, { bytes: Buffer.from('damaged'), contentType: 'image/jpeg' })
  assert.equal((await restore(w, f)).primary, 'corrupted')
  assert.deepEqual(primary.objects.get(f.key)?.bytes, Buffer.from('damaged'))
})

test('a valid primary is never overwritten, even with approval', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  const r = await restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: 'drill' })
  assert.equal(r.outcome, 'primary_valid')
  assert.ok(!primary.calls.includes('putBytes') && !primary.calls.includes('delete'))
  assert.deepEqual(await auditTypes(w), [])
})

test('an approved restore recovers the exact bytes via a staging key and is audited', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  const backupCallsBefore = backup.calls.length
  for (const damage of ['missing', 'corrupted']) {
    if (damage === 'missing') primary.objects.delete(f.key); else primary.objects.set(f.key, { bytes: Buffer.from('damaged'), contentType: 'image/jpeg' })
    const r = await restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: `drill ${damage}` })
    assert.equal(r.outcome, 'restored'); assert.equal(r.primary, damage)
    assert.deepEqual(primary.objects.get(f.key)?.bytes, f.bytes)
    assert.equal(sha256Hex(primary.objects.get(f.key)!.bytes), f.sha)
    assert.deepEqual([...primary.objects.keys()], [f.key], 'staging object removed')
  }
  assert.deepEqual(await auditTypes(w), ['ops.technician.file.restore_started', 'ops.technician.file.restore_completed', 'ops.technician.file.restore_started', 'ops.technician.file.restore_completed'])
  const started = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: w.ws.id, type: 'ops.technician.file.restore_started' } })
  assert.equal(started.actorUserId, w.owner.id)
  assert.deepEqual([...new Set(backup.calls.slice(backupCallsBefore))], ['getBytes'], 'restore only reads the backup')
})

test('execute needs an owner of that workspace, a reason, and all three matching ids', async () => {
  const a = await world('a@example.test'); const b = await world('b@example.test')
  const f = await backedUp(a)
  primary.objects.delete(f.key)
  const member = await seedUser('member@example.test')
  await prisma.membership.create({ data: { workspaceId: a.ws.id, userId: member.id, role: 'member' } })
  const admin = await seedUser('admin@example.test')
  await prisma.membership.create({ data: { workspaceId: a.ws.id, userId: admin.id, role: 'admin' } })
  await refused(restore(a, f, { execute: true, reason: 'drill' }), /approval required/)
  await refused(restore(a, f, { execute: true, approvedByUserId: a.owner.id }), /reason/)
  await refused(restore(a, f, { execute: true, approvedByUserId: a.owner.id, reason: '   ' }), /reason/)
  await refused(restore(a, f, { execute: true, approvedByUserId: member.id, reason: 'drill' }), /not an owner/)
  await refused(restore(a, f, { execute: true, approvedByUserId: admin.id, reason: 'drill' }), /not an owner/)
  await refused(restore(a, f, { execute: true, approvedByUserId: b.owner.id, reason: 'drill' }), /not an owner/)   // owner of ANOTHER workspace
  await refused(restore(a, f, { execute: true, approvedByUserId: 'no-such-user', reason: 'drill' }), /not an owner/)
  // forged workspace / job / file combinations
  await refused(restoreEvidenceFile({ workspaceId: b.ws.id, jobId: a.job.id, fileId: f.file.id, primary, backup }), /no such file/)
  await refused(restoreEvidenceFile({ workspaceId: a.ws.id, jobId: b.job.id, fileId: f.file.id, primary, backup }), /no such file/)
  await refused(restoreEvidenceFile({ workspaceId: a.ws.id, jobId: a.job.id, fileId: 'nope', primary, backup }), /no such file/)
  assert.equal(primary.objects.size, 0, 'nothing restored by any refused attempt')
  // the seven refused approvals are recorded on the file's own workspace; the forged ids are not
  assert.deepEqual(await auditTypes(a), Array(7).fill('ops.technician.file.restore_refused'))
  assert.deepEqual(await auditTypes(b), [], 'another workspace sees nothing of it')
  const last = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: a.ws.id, type: 'ops.technician.file.restore_refused' }, orderBy: { createdAt: 'desc' } })
  assert.equal((last.metadata as { why: string }).why, 'approver is not an owner of this workspace')
})

test('restore refuses without a VERIFIED backup, with a bad backup object, or for files that are not AVAILABLE', async () => {
  const w = await world('a@example.test')
  const none = await available(w)
  await refused(restore(w, none), /no VERIFIED backup/)
  const f = await backedUp(w)
  primary.objects.delete(f.key)
  backup.objects.get(f.key)!.bytes = Buffer.from('rot')
  await refused(restore(w, f), /failed integrity/)
  backup.objects.delete(f.key)
  await refused(restore(w, f), /backup object is missing/)
  await prisma.evidenceFile.update({ where: { id: f.file.id }, data: { status: 'DELETED', deletedAt: new Date() } })
  await refused(restore(w, f), /not AVAILABLE/)
  assert.ok(!primary.objects.has(f.key), 'nothing was restored')
})

test('restore is refused when its audit record cannot be written, and changes nothing', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  primary.objects.delete(f.key)
  const original = prisma.auditEvent.create
  ;(prisma.auditEvent as { create: unknown }).create = async () => { throw new Error('audit store down') }
  try {
    await assert.rejects(() => restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: 'drill' }), /audit store down/)
  } finally { (prisma.auditEvent as { create: unknown }).create = original }
  assert.equal(primary.objects.size, 0)
})

test('a failed staged copy or promotion never leaves a partial primary object behind', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  primary.objects.delete(f.key)
  primary.onPut = (key) => { if (key.includes('/restore/')) primary.objects.get(key)!.bytes = Buffer.from('corrupt') }
  await refused(restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: 'drill' }), /staged copy failed/)
  assert.equal(primary.objects.size, 0, 'neither the primary nor the staging object remains')
  // another actor repairs the primary while we work: we must not overwrite it
  primary.onPut = (key) => { if (key.includes('/restore/')) primary.objects.set(f.key, { bytes: f.bytes, contentType: 'image/jpeg' }) }
  const r = await restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: 'drill' })
  assert.equal(r.outcome, 'primary_valid')
  assert.deepEqual([...primary.objects.keys()], [f.key])
})

test('a transient read error on the primary is not mistaken for damage', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  primary.failNext = { op: 'getBytes', times: 1 }
  await assert.rejects(() => restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: 'drill' }), /injected getBytes failure/)
  assert.deepEqual(primary.objects.get(f.key)?.bytes, f.bytes)
})

test('restore reports active legal holds and does not depend on them', async () => {
  const w = await world('a@example.test')
  const f = await backedUp(w)
  primary.objects.delete(f.key)
  await prisma.legalHold.create({ data: { workspaceId: w.ws.id, scope: 'JOB', jobId: w.job.id, reason: 'dispute', placedByUserId: w.owner.id } })
  assert.equal((await restore(w, f)).activeHolds, 1)
  assert.equal((await restore(w, f, { execute: true, approvedByUserId: w.owner.id, reason: 'drill' })).outcome, 'restored')
})
