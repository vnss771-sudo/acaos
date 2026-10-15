// Integration tests against REAL S3-compatible servers (disposable primary + backup).
// Skipped unless ACAOS_S3_IT=1 and the EVIDENCE_* / EVIDENCE_BACKUP_* variables point at
// throwaway local servers with empty buckets (loopback http is accepted by the config
// outside production). Nothing here touches a real provider account. The
// ACAOS_S3_IT_BACKUP_CONTAINER variable (a local docker container name) additionally
// enables the network-interruption test. See docs/runbooks/EVIDENCE_RESTORE_DRILL.md.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import express from 'express'
import sharp from 'sharp'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { technicianFilesRouter, setFinalizeEnqueuerForTests } from '../apps/api/src/routes/ops/evidenceFiles.ts'
import { finalizeEvidenceFile } from '../apps/worker/src/processors/evidenceFinalize.ts'
import { replicateEvidenceFile, sweepEvidenceBackups, verifyEvidenceBackups, sha256Hex } from '../apps/worker/src/processors/evidenceBackup.ts'
import { restoreEvidenceFile, RestoreRefusedError } from '../apps/worker/src/processors/evidenceRestore.ts'
import { evidenceGovernanceRouter, setApiLedgerForTests } from '../apps/api/src/routes/ops/evidenceGovernance.ts'
import { runDeletionCycle, reconcileEvidenceLedger, buildDeletionStores } from '../apps/worker/src/processors/evidenceDeletion.ts'
import { resolveEvidenceDeletion, resolveEvidenceLedger } from '../packages/backend-core/src/lib/evidenceDeletionConfig.ts'
import { EvidenceLedger, probeLedgerImmutability } from '../packages/backend-core/src/lib/evidenceLedger.ts'
import { getEvidenceStore, getEvidenceBackupStore, createS3EvidenceStore, setEvidenceStoreForTests, setEvidenceBackupStoreForTests } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { resolveEvidenceStorage } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { resolveEvidenceBackup } from '../packages/backend-core/src/lib/evidenceBackupConfig.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

const ENABLED = process.env.ACAOS_S3_IT === '1'
const it = (name: string, fn: () => Promise<void>) => test(name, { skip: !ENABLED && 'set ACAOS_S3_IT=1 with disposable S3 servers' }, fn)

let tech: TestServer
let gov: TestServer
let queued: Array<{ workspaceId: string; fileId: string }>
const ps = ENABLED ? resolveEvidenceStorage() : null
const bs = ENABLED ? resolveEvidenceBackup() : null
const primary = () => { if (!ps?.enabled) throw new Error('primary config invalid'); return getEvidenceStore(ps.config) }
const backup = () => { if (!bs?.enabled) throw new Error('backup config invalid'); return getEvidenceBackupStore(bs.config) }

before(async () => {
  if (!ENABLED) return
  setEvidenceStoreForTests(null); setEvidenceBackupStoreForTests(null)   // the REAL S3 stores
  assert.ok(ps?.enabled, `primary config: ${JSON.stringify(ps && !ps.enabled ? ps.problems : '')}`)
  assert.ok(bs?.enabled, `backup config: ${JSON.stringify(bs && !bs.enabled ? bs.problems : '')}`)
  const combined = express.Router(); combined.use(technicianRouter); combined.use(technicianFilesRouter)
  tech = await startTestServer('/api/ops/technician', combined)
  gov = await startTestServer('/api/ops/evidence-governance', evidenceGovernanceRouter)
  const l = resolveEvidenceLedger()
  if (l.enabled) setApiLedgerForTests(new EvidenceLedger(createS3EvidenceStore(l.config), l.config.macKey))
})
after(async () => {
  setFinalizeEnqueuerForTests(null)
  setApiLedgerForTests(undefined)
  if (ENABLED) { await tech.close(); await gov.close() }
  await disconnect()
})
beforeEach(async () => {
  if (!ENABLED) return
  await resetDb()
  queued = []
  setFinalizeEnqueuerForTests((async (o: { workspaceId: string; fileId: string }) => { queued.push(o); return {} }) as never)
})

// ── fixtures ────────────────────────────────────────────────────────────────

const jpegWithGps = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).jpeg().withExif({
  IFD0: { Copyright: 'secret-owner-name' },
  IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' },
}).toBuffer()

/** A real HTTP PUT, so Content-Length / Content-Type are exactly what the client sends. */
function httpPut(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ method: 'PUT', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject); req.end(body)
  })
}

async function world(email: string) {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const user = await seedUser(`w-${Math.random().toString(36).slice(2, 7)}@example.test`)
  await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'member' } })
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: 'E1', fullName: 'Tech', role: 'TECH', userId: user.id } })
  await prisma.jobTechnicianAssignment.create({ data: { workspaceId: workspace.id, jobId: job.id, crewMemberId: crew.id } })
  return { owner, ws: workspace, job, user, crew }
}
type World = Awaited<ReturnType<typeof world>>

const call = (uid: string, method: string, path: string, body?: unknown) =>
  tech.request(path, { method, headers: { Authorization: bearer(uid), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/** init -> real PUT to the presigned URL -> complete. Returns the file id. */
async function upload(w: World, bytes: Buffer, over: Record<string, unknown> = {}): Promise<string> {
  const init = await call(w.user.id, 'POST', `/api/ops/technician/${w.job.id}/files/init`,
    { workspaceId: w.ws.id, submissionId: randomUUID(), contentType: 'image/jpeg', sizeBytes: bytes.length, ...over })
  assert.ok([200, 201].includes(init.status), `init ${init.status} ${JSON.stringify(init.body)}`)
  const status = await httpPut(init.body.upload.url, init.body.upload.headers, bytes)
  assert.equal(status, 200, 'presigned PUT accepted by the real server')
  const done = await call(w.user.id, 'POST', `/api/ops/technician/${w.job.id}/files/${init.body.file.id}/complete`, { workspaceId: w.ws.id })
  assert.ok([200, 202].includes(done.status), `complete ${done.status}`)
  return init.body.file.id as string
}
async function finalized(w: World): Promise<{ fileId: string; key: string; sha: string; bytes: Buffer }> {
  const fileId = await upload(w, await jpegWithGps())
  assert.equal((await finalizeEvidenceFile({ workspaceId: w.ws.id, fileId })).outcome, 'finalized')
  const f = await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId }, include: { copies: true } })
  const prim = f.copies.find((c: { location: string }) => c.location === 'primary')!
  const bytes = (await primary().getBytes(prim.objectKey, 25 * 1024 * 1024))!
  return { fileId, key: prim.objectKey, sha: f.sha256!, bytes }
}
const backupRow = (fileId: string) => prisma.evidenceFileCopy.findFirstOrThrow({ where: { fileId, location: 'backup' } })
const opts = (w: World, fileId: string) => ({ workspaceId: w.ws.id, jobId: w.job.id, fileId })

// ── tests ───────────────────────────────────────────────────────────────────

it('upload -> finalize -> backup -> primary loss -> dry-run -> approved restore, all on real S3 servers', async () => {
  const w = await world('a@example.test')
  const f = await finalized(w)
  // finalisation stripped EXIF/GPS and re-encoded
  const meta = await sharp(f.bytes).metadata()
  assert.equal(meta.format, 'jpeg'); assert.ok(!meta.exif, 'no EXIF in the stored object')
  assert.equal(sha256Hex(f.bytes), f.sha)

  assert.deepEqual(await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId }), { outcome: 'verified' })
  const row = await backupRow(f.fileId)
  assert.equal(row.status, 'VERIFIED'); assert.equal(row.sha256, f.sha)
  assert.equal(sha256Hex((await backup().getBytes(f.key, 25 * 1024 * 1024))!), f.sha, 'backup read-back checksum equals primary')

  await primary().delete(f.key)                                   // simulated primary loss (disposable bucket)
  assert.equal(await primary().head(f.key), null)
  const dry = await restoreEvidenceFile(opts(w, f.fileId))
  assert.equal(dry.outcome, 'would_restore'); assert.equal(dry.primary, 'missing')
  assert.equal(await primary().head(f.key), null, 'dry-run changed nothing')

  await assert.rejects(() => restoreEvidenceFile({ ...opts(w, f.fileId), execute: true, approvedByUserId: w.user.id, reason: 'drill' }), RestoreRefusedError)
  const r = await restoreEvidenceFile({ ...opts(w, f.fileId), execute: true, approvedByUserId: w.owner.id, reason: 'drill on real S3' })
  assert.equal(r.outcome, 'restored')
  const back = (await primary().getBytes(f.key, 25 * 1024 * 1024))!
  assert.equal(sha256Hex(back), f.sha); assert.equal(back.length, f.bytes.length)
  assert.equal((await restoreEvidenceFile(opts(w, f.fileId))).outcome, 'primary_valid')
})

it('the real server enforces the presigned size and type, and refuses a tampered URL', async () => {
  const w = await world('a@example.test')
  const bytes = await jpegWithGps()
  const init = await call(w.user.id, 'POST', `/api/ops/technician/${w.job.id}/files/init`,
    { workspaceId: w.ws.id, submissionId: randomUUID(), contentType: 'image/jpeg', sizeBytes: bytes.length })
  const { url, headers } = init.body.upload
  assert.notEqual(await httpPut(url, { ...headers, 'Content-Length': String(bytes.length + 5) }, Buffer.concat([bytes, Buffer.from('extra')])), 200, 'oversized body refused')
  assert.notEqual(await httpPut(url, { ...headers, 'Content-Type': 'text/html' }, bytes), 200, 'wrong content type refused')
  assert.notEqual(await httpPut(url.replace(/(\/ws\/[^/]+\/job\/[^/]+\/upload\/)[^?]+/, '$1other'), headers, bytes), 200, 'other key refused')
  assert.equal(await httpPut(url, headers, bytes), 200, 'the exact signed request still works')
})

it('conditional writes are enforced by the real server (the restore overwrite protection)', async () => {
  const w = await world('a@example.test')
  const key = `ws/${w.ws.id}/job/${w.job.id}/restore/${randomUUID().replace(/-/g, '')}`
  const p = primary()
  assert.equal(await p.putBytesIf(key, Buffer.from('one'), 'image/jpeg', { ifNoneMatch: true }), 'written')
  assert.equal(await p.putBytesIf(key, Buffer.from('two'), 'image/jpeg', { ifNoneMatch: true }), 'precondition_failed')
  assert.deepEqual(await p.getBytes(key, 100), Buffer.from('one'), 'a refused create did not overwrite')
  const seen = (await p.getBytesWithEtag(key, 100))!
  assert.equal(await p.putBytesIf(key, Buffer.from('three'), 'image/jpeg', { ifMatch: '"not-the-etag"' }), 'precondition_failed')
  assert.deepEqual(await p.getBytes(key, 100), Buffer.from('one'), 'a stale ETag did not overwrite')
  assert.equal(await p.putBytesIf(key, Buffer.from('three'), 'image/jpeg', { ifMatch: seen.etag }), 'written')
  assert.deepEqual(await p.getBytes(key, 100), Buffer.from('three'))
  await p.delete(key)
  assert.equal(await p.putBytesIf(key, Buffer.from('four'), 'image/jpeg', { ifMatch: seen.etag }), 'precondition_failed', 'if-match on a missing object must not create it')
  assert.equal(await p.head(key), null)
})

it('concurrent restores against the real server write the primary once', async () => {
  const w = await world('a@example.test')
  const f = await finalized(w)
  await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId })
  await primary().delete(f.key)
  const go = () => restoreEvidenceFile({ ...opts(w, f.fileId), execute: true, approvedByUserId: w.owner.id, reason: 'race drill' }).catch((e: Error) => e)
  const results = await Promise.all([go(), go(), go(), go(), go()])
  const outcomes = results.map((r) => (r instanceof Error ? r.message : r.outcome))
  assert.equal(outcomes.filter((o) => o === 'restored').length, 1, JSON.stringify(outcomes))
  assert.ok(outcomes.every((o) => o === 'restored' || o === 'primary_valid'), JSON.stringify(outcomes))
  assert.equal(sha256Hex((await primary().getBytes(f.key, 25 * 1024 * 1024))!), f.sha)
})

it('a corrupted backup object is detected by the verifier and blocks re-replication (never overwritten)', async () => {
  const w = await world('a@example.test')
  const f = await finalized(w)
  await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId })
  await backup().putBytes(f.key, Buffer.from('bit rot'), 'image/jpeg')           // corrupt it behind our back
  const v = await verifyEvidenceBackups({ workspaceId: w.ws.id })
  assert.deepEqual(v, { checked: 1, ok: 0, missing: 0, mismatched: 1 })
  assert.equal((await backupRow(f.fileId)).lastError, 'verify_mismatch')
  assert.deepEqual(await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId }), { outcome: 'failed', reason: 'backup_conflict' })
  assert.deepEqual(await backup().getBytes(f.key, 100), Buffer.from('bit rot'), 'the foreign object is left for a human')
  await new Promise((r) => setTimeout(r, 100))
  const types = (await prisma.auditEvent.findMany({ where: { workspaceId: w.ws.id, entityId: f.fileId } })).map((e: { type: string }) => e.type)
  assert.ok(types.includes('ops.technician.file.backup_incident'))
})

it('a primary that changed behind our back is never copied to the backup', async () => {
  const w = await world('a@example.test')
  const f = await finalized(w)
  await primary().putBytes(f.key, Buffer.from('tampered'), 'image/jpeg')
  assert.deepEqual(await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId }), { outcome: 'failed', reason: 'primary_mismatch' })
  assert.equal(await backup().head(f.key), null)
})

const container = process.env.ACAOS_S3_IT_BACKUP_CONTAINER
test('network interruption: the backup server goes away mid-run, the failure is recorded, and the retry succeeds',
  { skip: (!ENABLED || !container) && 'needs ACAOS_S3_IT_BACKUP_CONTAINER (a local docker container)' }, async () => {
    const w = await world('a@example.test')
    const f = await finalized(w)
    execFileSync('docker', ['stop', '-t', '2', container!])
    try {
      await assert.rejects(() => replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId }))
      const row = await backupRow(f.fileId)
      assert.equal(row.status, 'FAILED'); assert.equal(row.lastError, 'transient'); assert.equal(row.attempts, 1)
      assert.deepEqual(await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId, lastAttempt: true }), { outcome: 'failed', reason: 'transient' })
    } finally {
      execFileSync('docker', ['start', container!])
    }
    for (let i = 0; i < 60; i++) {   // wait for the server to accept requests again
      try { await backup().head('ws/probe/job/probe/final/x'); break } catch { await new Promise((r) => setTimeout(r, 1000)) }
    }
    assert.deepEqual(await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId }), { outcome: 'verified' })
    assert.equal((await backupRow(f.fileId)).status, 'VERIFIED')
  })

const child = (mode: string, w: World, fileId: string) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'tests-db/helpers/crash-child.ts', mode, w.ws.id, fileId], {
    env: { ...process.env, NODE_OPTIONS: '--conditions=acaos-src' }, encoding: 'utf8', timeout: 120_000,
  })

it('worker killed (SIGKILL) after writing the backup object: the sweep re-queues it and the retry verifies it', async () => {
  const w = await world('a@example.test')
  const f = await finalized(w)
  const r = child('backup', w, f.fileId)
  assert.equal(r.signal, 'SIGKILL', `child output: ${r.stdout}${r.stderr}`.slice(0, 500))
  const row = await backupRow(f.fileId)
  assert.equal(row.status, 'VERIFYING', 'the dead worker left the copy mid-flight'); assert.equal(row.attempts, 1)
  assert.ok(await backup().head(f.key), 'the object it wrote is there')
  // the durable sweep finds it after the retry window and queues it
  const q: string[] = []
  await sweepEvidenceBackups({ enqueue: async (o) => { q.push(o.fileId) } })
  assert.deepEqual(q, [], 'not before the retry window')
  await sweepEvidenceBackups({ enqueue: async (o) => { q.push(o.fileId) }, now: new Date(Date.now() + 20 * 60_000) })
  assert.deepEqual(q, [f.fileId])
  assert.deepEqual(await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId }), { outcome: 'verified' })
  const done = await backupRow(f.fileId)
  assert.equal(done.status, 'VERIFIED'); assert.equal(done.attempts, 2)
})

it('worker killed (SIGKILL) after publishing the final object: finalisation completes on retry', async () => {
  const w = await world('a@example.test')
  const fileId = await upload(w, await jpegWithGps())
  const r = child('finalize', w, fileId)
  assert.equal(r.signal, 'SIGKILL', `child output: ${r.stdout}${r.stderr}`.slice(0, 500))
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId } })).status, 'PENDING', 'nothing was committed')
  assert.equal((await finalizeEvidenceFile({ workspaceId: w.ws.id, fileId })).outcome, 'finalized')
  const f = await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId }, include: { copies: true } })
  assert.equal(f.status, 'AVAILABLE')
  const prim = f.copies.find((c: { location: string }) => c.location === 'primary')!
  assert.equal(sha256Hex((await primary().getBytes(prim.objectKey, 25 * 1024 * 1024))!), f.sha256)
})


// ── C4: governed deletion against real servers ──────────────────────────────
// The deletion runner's dedicated credentials are supplied as ACAOS_IT_DELETE_* and mapped
// onto EVIDENCE_DELETE_* only for the runner (the upload and backup resolvers disable
// themselves when those variables are present in their own process).

const deleteEnv = (over: Record<string, string | undefined> = {}) => ({
  ...process.env,
  EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID: process.env.ACAOS_IT_DELETE_PRIMARY_ACCESS_KEY_ID,
  EVIDENCE_DELETE_PRIMARY_SECRET_ACCESS_KEY: process.env.ACAOS_IT_DELETE_PRIMARY_SECRET_ACCESS_KEY,
  EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID: process.env.ACAOS_IT_DELETE_BACKUP_ACCESS_KEY_ID,
  EVIDENCE_DELETE_BACKUP_SECRET_ACCESS_KEY: process.env.ACAOS_IT_DELETE_BACKUP_SECRET_ACCESS_KEY,
  ...over,
})
const DAYS = (n: number) => n * 86_400_000
const GV = (uid: string, method: string, path: string, body?: unknown) =>
  gov.request(`/api/ops/evidence-governance${path}`, { method, headers: { Authorization: bearer(uid), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/** A finalised, backed-up file that is old enough to delete, with an approved request. */
async function approvedDeletion(w: World) {
  const f = await finalized(w)
  assert.equal((await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.fileId })).outcome, 'verified')
  const old = new Date(Date.now() - DAYS(8 * 365))
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE', completedAt: old } })
  await prisma.evidenceFile.update({ where: { id: f.fileId }, data: { finalizedAt: old } })
  const owner2 = await seedUser(`o2-${Math.random().toString(36).slice(2, 7)}@example.test`)
  await prisma.membership.create({ data: { workspaceId: w.ws.id, userId: owner2.id, role: 'owner' } })
  const r = await GV(w.owner.id, 'POST', '/deletion-requests', { workspaceId: w.ws.id, fileId: f.fileId, reason: 'Customer contract ended; retention elapsed' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const a = await GV(owner2.id, 'POST', `/deletion-requests/${r.body.request.id}/approve`, { workspaceId: w.ws.id })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  return { ...f, requestId: r.body.request.id as string, due: new Date(new Date(a.body.request.notBefore).getTime() + 1000) }
}
const realLedger = () => { const l = resolveEvidenceLedger(); if (!l.enabled) throw new Error('ledger config invalid'); return new EvidenceLedger(createS3EvidenceStore(l.config), l.config.macKey) }

it('the real ledger credential is probed honestly, and the runner gate follows the measurement', async () => {
  const l = resolveEvidenceLedger(); assert.ok(l.enabled)
  const probe = await probeLedgerImmutability(createS3EvidenceStore(l.config))
  console.log(`# ledger probe on the local S3 server: ${JSON.stringify(probe)}`)
  assert.equal(probe.createOnly, true, 'conditional create-only works on this server')
  // Without the dev override the runner runs only if the measurement says "enforced".
  const strict = await runDeletionCycle({ env: deleteEnv({ EVIDENCE_LEDGER_ALLOW_UNENFORCED: undefined }) })
  if (probe.level === 'enforced') assert.ok('reconcile' in strict, 'enforced ledger: the cycle runs')
  else assert.ok('skipped' in strict && strict.skipped === 'ledger_not_trusted', `a ${probe.level} ledger is refused: ${JSON.stringify(strict)}`)
})

it('request -> review -> wait -> deletion removes both real copies, records them in the real ledger, and is idempotent', async () => {
  const w = await world('a@example.test')
  const d = await approvedDeletion(w)
  assert.ok(await primary().head(d.key) && await backup().head(d.key))
  const early = await runDeletionCycle({ env: deleteEnv(), now: new Date() })
  assert.ok('executed' in early && early.executed.length === 0, 'inside the waiting period nothing happens')
  const run1 = await runDeletionCycle({ env: deleteEnv(), now: d.due })
  assert.ok('executed' in run1, JSON.stringify(run1)); assert.equal(run1.executed[0].result.outcome, 'completed')
  assert.equal(await primary().head(d.key), null); assert.equal(await backup().head(d.key), null)
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: d.fileId } })).status, 'DELETED')
  const st = (await realLedger().fileStates(w.ws.id)).states.get(d.fileId)!
  assert.equal(st.completed, true); assert.equal(st.started?.sha256, d.sha)
  assert.ok((await realLedger().verifyChain(w.ws.id)).ok)
  assert.ok((await realLedger().workspaces()).includes(w.ws.id), 'the real ledger lists the workspace')
  const run2 = await runDeletionCycle({ env: deleteEnv(), now: d.due })
  assert.ok('executed' in run2 && run2.executed.length === 0)
})

it('a database rolled back after a deletion is reconciled against the real ledger (stale objects removed too)', async () => {
  const w = await world('a@example.test')
  const d = await approvedDeletion(w)
  await runDeletionCycle({ env: deleteEnv(), now: d.due })
  // "restore an older database": the file is AVAILABLE again, and stale object copies are back
  await prisma.evidenceFile.update({ where: { id: d.fileId }, data: { status: 'AVAILABLE', deletedAt: null } })
  await prisma.evidenceFileCopy.updateMany({ where: { fileId: d.fileId, location: { in: ['primary', 'backup'] } }, data: { status: 'VERIFIED', deletedAt: null } })
  await primary().putBytes(d.key, d.bytes, 'image/jpeg'); await backup().putBytes(d.key, d.bytes, 'image/jpeg')
  const cfg = resolveEvidenceDeletion(deleteEnv()); assert.ok(cfg.enabled)
  const rep = await reconcileEvidenceLedger({ stores: buildDeletionStores(cfg.config), workspaceId: w.ws.id })
  assert.equal(rep.retombstoned, 1); assert.deepEqual(rep.conflicts, []); assert.equal(rep.objectsRemoved, 2)
  assert.equal(await primary().head(d.key), null); assert.equal(await backup().head(d.key), null)
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: d.fileId } })).status, 'DELETED')
})

it('worker killed (SIGKILL) right after the primary object is deleted: the deletion is visible, partial, and resumes', async () => {
  const w = await world('a@example.test')
  const d = await approvedDeletion(w)
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'tests-db/helpers/crash-child.ts', 'delete', d.requestId, String(d.due.getTime())], {
    env: { ...deleteEnv(), NODE_OPTIONS: '--conditions=acaos-src' } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000,
  })
  assert.equal(r.signal, 'SIGKILL', `child output: ${r.stdout}${r.stderr}`.slice(0, 600))
  assert.equal(await primary().head(d.key), null, 'the primary was deleted before the crash')
  assert.ok(await backup().head(d.key), 'the backup is still there: recoverable')
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: d.fileId } })).status, 'DELETING', 'visibly partial, not DELETED')
  assert.equal((await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id: d.requestId } })).status, 'EXECUTING')
  const st = (await realLedger().fileStates(w.ws.id)).states.get(d.fileId)!
  assert.ok(st.started && !st.completed, 'the ledger shows it started, not finished')
  const resumed = await runDeletionCycle({ env: deleteEnv(), now: d.due })
  // The cycle reconciles against the ledger first, which may finish the interrupted deletion itself;
  // either path must end in the same place.
  assert.ok('reconcile' in resumed && (resumed.reconcile.resumed === 1 || resumed.executed.some((e) => e.requestId === d.requestId && e.result.outcome === 'completed')), JSON.stringify(resumed))
  assert.equal(await backup().head(d.key), null)
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: d.fileId } })).status, 'DELETED')
  assert.equal((await realLedger().fileStates(w.ws.id)).states.get(d.fileId)?.completed, true)
})

it('a hold is written to the real ledger before it is acknowledged, and a database restore cannot lose it', async () => {
  const w = await world('a@example.test')
  const placed = await GV(w.owner.id, 'POST', '/holds', { workspaceId: w.ws.id, scope: 'JOB', jobId: w.job.id, reason: 'regulator enquiry 2026-14' })
  assert.equal(placed.status, 201); assert.equal(placed.body.ledgered, true)
  assert.equal((await realLedger().holdStates(w.ws.id)).holds.get(placed.body.hold.id)?.placed?.jobId, w.job.id)
  await prisma.legalHold.delete({ where: { id: placed.body.hold.id } })           // "restore": the row is gone
  const cfg = resolveEvidenceDeletion(deleteEnv()); assert.ok(cfg.enabled)
  const rep = await reconcileEvidenceLedger({ stores: buildDeletionStores(cfg.config) })   // all workspaces, discovered via the ledger
  assert.ok(rep.holdsRecreated >= 1)
  assert.equal((await prisma.legalHold.findUniqueOrThrow({ where: { id: placed.body.hold.id } })).releasedAt, null)
})
