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
import { getEvidenceStore, getEvidenceBackupStore, setEvidenceStoreForTests, setEvidenceBackupStoreForTests } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { resolveEvidenceStorage } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { resolveEvidenceBackup } from '../packages/backend-core/src/lib/evidenceBackupConfig.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

const ENABLED = process.env.ACAOS_S3_IT === '1'
const it = (name: string, fn: () => Promise<void>) => test(name, { skip: !ENABLED && 'set ACAOS_S3_IT=1 with disposable S3 servers' }, fn)

let tech: TestServer
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
})
after(async () => {
  setFinalizeEnqueuerForTests(null)
  if (ENABLED) await tech.close()
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
