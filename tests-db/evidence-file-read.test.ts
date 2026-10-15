// C5a tests: reading technician photo evidence (list, signed content, thumbnails) and
// cancelling an unfinished upload. Real PostgreSQL (tenant guard enforcing), real routes and
// worker processors, in-memory object store that mimics what the provider enforces.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import sharp from 'sharp'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { technicianFilesRouter, setFinalizeEnqueuerForTests } from '../apps/api/src/routes/ops/evidenceFiles.ts'
import { finalizeEvidenceFile, sweepAbandonedEvidenceUploads } from '../apps/worker/src/processors/evidenceFinalize.ts'
import { MemoryEvidenceStore, setEvidenceStoreForTests } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

const ENV = {
  EVIDENCE_UPLOADS_ENABLED: 'true',
  EVIDENCE_S3_ENDPOINT: 'https://storage.example.test',
  EVIDENCE_S3_BUCKET: 'acaos-evidence-test',
  EVIDENCE_S3_ACCESS_KEY_ID: 'AKIATESTONLY',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'test-only-secret',
}
const ENV_KEYS = Object.keys(ENV)
const saved: Record<string, string | undefined> = {}

let tech: TestServer
let store: MemoryEvidenceStore

/** A store whose thumbnail writes fail, to show a missing thumbnail never blocks evidence. */
class NoThumbStore extends MemoryEvidenceStore {
  override async putBytes(key: string, body: Buffer, contentType: string) {
    if (key.includes('/thumb/')) throw new Error('injected thumbnail failure')
    return super.putBytes(key, body, contentType)
  }
}

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  const combined = express.Router()
  combined.use(technicianRouter)
  combined.use(technicianFilesRouter)
  tech = await startTestServer('/api/ops/technician', combined)
})
after(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  setEvidenceStoreForTests(null)
  setFinalizeEnqueuerForTests(null)
  await tech.close(); await disconnect()
})
beforeEach(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  store = new MemoryEvidenceStore()
  setEvidenceStoreForTests(store)
  setFinalizeEnqueuerForTests((async () => ({})) as never)
})

const photo = (w = 800, h = 600) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })
  .jpeg().withExif({ IFD0: { Copyright: 'secret-owner-name' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1' } }).toBuffer()

const T = (uid: string | null, method: string, path: string, body?: unknown) => tech.request(path, {
  method,
  headers: { ...(uid ? { Authorization: bearer(uid) } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function world(email: string) {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const otherJob = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  let n = 0
  const worker = async (opts: { assign?: boolean } = {}) => {
    const user = await seedUser(`w${++n}-${Math.random().toString(36).slice(2, 6)}@example.test`)
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'member' } })
    const crew = await prisma.opsCrewMember.create({ data: {
      workspaceId: workspace.id, employeeCode: `E${n}`, fullName: `Worker ${n}`, role: 'TECH', userId: user.id, isActive: true,
    } })
    if (opts.assign !== false) await prisma.jobTechnicianAssignment.create({ data: { workspaceId: workspace.id, jobId: job.id, crewMemberId: crew.id } })
    return { user, crew }
  }
  return { owner, ws: workspace, job, otherJob, worker }
}
type World = Awaited<ReturnType<typeof world>>
type Tech = Awaited<ReturnType<World['worker']>>

const q = (w: World, extra = '') => `workspaceId=${w.ws.id}${extra}`
const listUrl = (w: World, jobId = w.job.id, extra = '') => `/api/ops/technician/${jobId}/files?${q(w, extra)}`
const contentUrl = (w: World, fileId: string, extra = '', jobId = w.job.id) => `/api/ops/technician/${jobId}/files/${fileId}/content?${q(w, extra)}`

/** init → PUT → complete → worker finalisation, ending with an AVAILABLE file. */
async function available(w: World, t: Tech, jobId = w.job.id, bytes?: Buffer): Promise<string> {
  const b = bytes ?? await photo()
  const init = await T(t.user.id, 'POST', `/api/ops/technician/${jobId}/files/init`,
    { workspaceId: w.ws.id, submissionId: randomUUID(), contentType: 'image/jpeg', sizeBytes: b.length })
  assert.equal(init.status, 201, JSON.stringify(init.body))
  assert.equal(store.clientPut(init.body.upload.url, b, init.body.upload.headers).status, 200)
  const fileId = init.body.file.id as string
  const r = await finalizeEvidenceFile({ workspaceId: w.ws.id, fileId })
  assert.equal(r.outcome, 'finalized')
  return fileId
}
async function pending(w: World, t: Tech, jobId = w.job.id): Promise<string> {
  const b = await photo()
  const init = await T(t.user.id, 'POST', `/api/ops/technician/${jobId}/files/init`,
    { workspaceId: w.ws.id, submissionId: randomUUID(), contentType: 'image/jpeg', sizeBytes: b.length })
  assert.equal(init.status, 201)
  store.clientPut(init.body.upload.url, b, init.body.upload.headers)
  return init.body.file.id as string
}
const copy = (fileId: string, location: string) => prisma.evidenceFileCopy.findFirstOrThrow({ where: { fileId, location } })

// ── fail closed and capability flag ─────────────────────────────────────────

test('read endpoints fail closed with the flag off, and /assigned reports photos accordingly', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const fileId = await available(w, t)
  const assigned = () => T(t.user.id, 'GET', `/api/ops/technician/assigned?${q(w)}`)
  assert.equal((await assigned()).body.photos, true)

  process.env.EVIDENCE_UPLOADS_ENABLED = 'false'
  store.calls = []
  assert.equal((await T(t.user.id, 'GET', listUrl(w))).status, 503)
  assert.equal((await T(t.user.id, 'GET', contentUrl(w, fileId))).status, 503)
  assert.equal((await T(t.user.id, 'DELETE', `/api/ops/technician/${w.job.id}/files/${fileId}`, { workspaceId: w.ws.id })).status, 503)
  assert.equal((await assigned()).body.photos, false, 'the UI must not offer photos while the server refuses them')
  assert.equal(store.calls.length, 0)

  const stranger = await seedUser('nolink@example.test')
  await prisma.membership.create({ data: { workspaceId: w.ws.id, userId: stranger.id, role: 'member' } })
  assert.deepEqual((await T(stranger.id, 'GET', `/api/ops/technician/assigned?${q(w)}`)).body, { linked: false, photos: false, jobs: [] })
})

// ── thumbnails ──────────────────────────────────────────────────────────────

test('finalisation writes a small metadata-free thumbnail recorded as a VERIFIED thumb copy', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const fileId = await available(w, t, w.job.id, await photo(2400, 1600))
  const thumb = await copy(fileId, 'thumb')
  const primary = await copy(fileId, 'primary')
  assert.equal(thumb.status, 'VERIFIED')
  assert.ok(thumb.objectKey.includes(`/ws/`.slice(1)) && thumb.objectKey.includes('/thumb/'))
  assert.equal(thumb.objectKey.split('/').pop(), primary.objectKey.split('/').pop(), 'thumb key derives from the final key')
  const bytes = store.objects.get(thumb.objectKey)!.bytes
  assert.equal(thumb.sizeBytes, bytes.length)
  assert.ok(bytes.length < (store.objects.get(primary.objectKey)!.bytes.length))
  const meta = await sharp(bytes).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.ok(Math.max(meta.width!, meta.height!) <= 320)
  assert.equal(meta.exif, undefined, 'no EXIF in the thumbnail')
  assert.ok(!bytes.toString('latin1').includes('secret-owner-name'))
})

test('a thumbnail failure never blocks the evidence; the file just has no thumb', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  store = new NoThumbStore()
  setEvidenceStoreForTests(store)
  const fileId = await available(w, t)
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId } })).status, 'AVAILABLE')
  assert.equal((await copy(fileId, 'thumb')).status, 'PENDING')
  const list = await T(t.user.id, 'GET', listUrl(w))
  assert.equal(list.body.files[0].hasThumb, false)
  assert.equal((await T(t.user.id, 'GET', contentUrl(w, fileId, '&variant=thumb'))).status, 404)
  assert.equal((await T(t.user.id, 'GET', contentUrl(w, fileId))).status, 200, 'the full image is still served')
})

test('a rejected upload leaves no thumbnail object behind after the sweeper runs', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const fileId = await available(w, t)
  const thumb = await copy(fileId, 'thumb')
  // Simulate a file that was rejected after a thumbnail had been written.
  await prisma.evidenceFile.update({ where: { id: fileId }, data: { status: 'REJECTED' } })
  assert.ok(store.objects.has(thumb.objectKey))
  await sweepAbandonedEvidenceUploads({ store })
  assert.ok(!store.objects.has(thumb.objectKey), 'thumbnail object removed')
  assert.equal((await copy(fileId, 'thumb')).status, 'DELETED')
})

// ── list ────────────────────────────────────────────────────────────────────

test('list: a technician sees only their own files; a manager sees every AVAILABLE file with its uploader', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const b = await w.worker()
  const aFile = await available(w, a)
  const bFile = await available(w, b)
  const aPending = await pending(w, a)

  const mine = await T(a.user.id, 'GET', listUrl(w))
  assert.equal(mine.status, 200)
  assert.deepEqual(new Set(mine.body.files.map((f: { id: string }) => f.id)), new Set([aFile, aPending]))
  assert.ok(!mine.body.files.some((f: { id: string }) => f.id === bFile), "never another technician's file")
  assert.ok(mine.body.files.every((f: Record<string, unknown>) => !('uploadedBy' in f)), 'technicians get no uploader data')
  assert.equal(mine.headers.get('cache-control'), 'no-store')

  const mgr = await T(w.owner.id, 'GET', listUrl(w))
  assert.equal(mgr.status, 200)
  assert.deepEqual(new Set(mgr.body.files.map((f: { id: string }) => f.id)), new Set([aFile, bFile]), 'AVAILABLE only')
  const row = mgr.body.files.find((f: { id: string }) => f.id === bFile)
  assert.equal(row.uploadedBy.crewMemberId, b.crew.id)
  assert.equal(row.uploadedBy.name, b.crew.fullName)
  assert.equal(row.hasThumb, true)
  assert.equal(row.width, 800)

  // No object key, bucket or storage detail anywhere in either response.
  for (const body of [mine.body, mgr.body]) {
    const text = JSON.stringify(body)
    assert.ok(!/objectKey|ws\/|\/final\/|\/upload\/|\/thumb\/|acaos-evidence|AKIA/.test(text), text)
  }
})

test('list authorisation matrix', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const a = await w.worker()
  const unassigned = await w.worker({ assign: false })
  const stranger = await seedUser('stranger@example.test')
  await available(w, a)

  assert.equal((await T(null, 'GET', listUrl(w))).status, 401)
  assert.equal((await T(stranger.id, 'GET', listUrl(w))).status, 403, 'not a member')
  assert.equal((await T(unassigned.user.id, 'GET', listUrl(w))).status, 403, 'member of the workspace but not assigned')
  assert.equal((await T(other.owner.id, 'GET', listUrl(w))).status, 403, "another workspace's manager")
  assert.equal((await T(other.owner.id, 'GET', `/api/ops/technician/${other.job.id}/files?workspaceId=${w.ws.id}`)).status, 403)
  assert.equal((await T(w.owner.id, 'GET', `/api/ops/technician/${other.job.id}/files?${q(w)}`)).status, 404, "a manager cannot list another workspace's job")
  assert.equal((await T(a.user.id, 'GET', listUrl(w, w.otherJob.id))).status, 403, 'assigned to a different job only')
})

test('list: a technician loses read access when revoked or when the job closes; managers keep it', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  await available(w, a)
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE' } })
  assert.equal((await T(a.user.id, 'GET', listUrl(w))).status, 409, 'closed job: no technician read')
  const mgr = await T(w.owner.id, 'GET', listUrl(w))
  assert.equal(mgr.status, 200)
  assert.equal(mgr.body.files.length, 1, 'managers retain the historical evidence')
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'ACTIVE' } })
  await prisma.jobTechnicianAssignment.deleteMany({ where: { jobId: w.job.id, crewMemberId: a.crew.id } })
  assert.equal((await T(a.user.id, 'GET', listUrl(w))).status, 403, 'revoked')
})

test('list: keyset pagination is stable and rejects forged cursors', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const ids: string[] = []
  for (let i = 0; i < 5; i++) ids.push(await available(w, a))
  const seen: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 5; page++) {
    const r = await T(w.owner.id, 'GET', listUrl(w, w.job.id, `&limit=2${cursor ? `&cursor=${cursor}` : ''}`))
    assert.equal(r.status, 200)
    seen.push(...r.body.files.map((f: { id: string }) => f.id))
    cursor = r.body.nextCursor
    if (!cursor) break
  }
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5, 'no duplicates or gaps')
  assert.deepEqual(new Set(seen), new Set(ids))
  assert.equal((await T(w.owner.id, 'GET', listUrl(w, w.job.id, '&cursor=not-a-cursor'))).status, 400)
  const forged = Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: "x' OR 1=1" })).toString('base64url')
  assert.ok([400, 200].includes((await T(w.owner.id, 'GET', listUrl(w, w.job.id, `&cursor=${forged}`))).status))
  assert.equal((await T(w.owner.id, 'GET', listUrl(w, w.job.id, '&limit=1000'))).status, 400)
})

test('list never shows deleted or deleting files', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const f1 = await available(w, a)
  const f2 = await available(w, a)
  await prisma.evidenceFile.update({ where: { id: f1 }, data: { status: 'DELETING' } })
  await prisma.evidenceFile.update({ where: { id: f2 }, data: { status: 'DELETED', deletedAt: new Date() } })
  for (const uid of [a.user.id, w.owner.id]) {
    assert.deepEqual((await T(uid, 'GET', listUrl(w))).body.files, [])
    assert.equal((await T(uid, 'GET', contentUrl(w, f1))).status, 409)
  }
})

// ── content (signed GET) ────────────────────────────────────────────────────

test('content: a technician gets a short-lived signed URL for their own AVAILABLE photo', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const fileId = await available(w, a)
  const r = await T(a.user.id, 'GET', contentUrl(w, fileId))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.body.variant, 'full')
  const ttl = new Date(r.body.expiresAt).getTime() - Date.now()
  assert.ok(ttl > 0 && ttl <= 60_000, `TTL ${ttl} ms must be 60 s or less`)
  assert.ok(!/objectKey/.test(JSON.stringify(r.body)))
  const got = store.clientGet(r.body.url)
  assert.equal(got.status, 200)
  assert.equal(got.headers!['Content-Type'], 'image/jpeg')
  assert.equal(got.headers!['Content-Disposition'], 'inline')
  assert.equal(got.headers!['Cache-Control'], 'private, no-store')
  const meta = await sharp(got.bytes!).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.exif, undefined, 'what is served has no EXIF/GPS')

  const thumb = await T(a.user.id, 'GET', contentUrl(w, fileId, '&variant=thumb'))
  assert.equal(thumb.status, 200)
  assert.ok(store.clientGet(thumb.body.url).bytes!.length < got.bytes!.length)

  // The URL stops working once it has expired.
  store.now = () => Date.now() + 61_000
  assert.equal(store.clientGet(r.body.url).status, 403)
})

test('content: other technicians, other jobs, other workspaces and pending files are refused', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const a = await w.worker()
  const b = await w.worker()
  const fileId = await available(w, a)
  const pend = await pending(w, a)
  const foreign = await available(other, await other.worker(), other.job.id)

  assert.equal((await T(null, 'GET', contentUrl(w, fileId))).status, 401)
  assert.equal((await T(b.user.id, 'GET', contentUrl(w, fileId))).status, 404, "another technician's file looks missing")
  assert.equal((await T(a.user.id, 'GET', contentUrl(w, pend))).status, 409, 'not AVAILABLE yet')
  assert.equal((await T(a.user.id, 'GET', contentUrl(w, fileId, '', w.otherJob.id))).status, 403, 'wrong job')
  assert.equal((await T(w.owner.id, 'GET', contentUrl(w, fileId, '', w.otherJob.id))).status, 404, 'manager: right file, wrong job')
  assert.equal((await T(w.owner.id, 'GET', contentUrl(w, foreign))).status, 404, "a file from another workspace's job")
  assert.equal((await T(other.owner.id, 'GET', contentUrl(w, fileId))).status, 403, "another workspace's manager")
  assert.equal((await T(a.user.id, 'GET', contentUrl(w, fileId, '&variant=original'))).status, 400, 'unknown variant')
  assert.equal((await T(a.user.id, 'GET', contentUrl(w, 'nonexistent'))).status, 404)
})

test('content: managers read any technician\'s photo; technicians lose access when the job closes', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const fileId = await available(w, a)
  assert.equal((await T(w.owner.id, 'GET', contentUrl(w, fileId))).status, 200)
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE' } })
  assert.equal((await T(a.user.id, 'GET', contentUrl(w, fileId))).status, 409)
  assert.equal((await T(w.owner.id, 'GET', contentUrl(w, fileId))).status, 200, 'manager keeps historical access')
})

test('content: a copy whose key is outside the job is refused, and every view is audited', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const fileId = await available(w, a)
  const ok = await T(a.user.id, 'GET', contentUrl(w, fileId))
  assert.equal(ok.status, 200)
  await new Promise((r) => setTimeout(r, 200))
  const ev = await prisma.auditEvent.findFirst({ where: { workspaceId: w.ws.id, type: 'ops.technician.file.viewed', entityId: fileId } })
  assert.ok(ev, 'view audited')
  assert.equal(ev!.actorUserId, a.user.id)

  // A corrupted record pointing at another job's prefix must never be signed.
  const prim = await copy(fileId, 'primary')
  await prisma.$executeRaw`UPDATE "EvidenceFileCopy" SET "objectKey" = ${`ws/${w.ws.id}/job/${w.otherJob.id}/final/stolen`} WHERE "id" = ${prim.id}`
  assert.equal((await T(a.user.id, 'GET', contentUrl(w, fileId))).status, 500)
})

// ── cancel ──────────────────────────────────────────────────────────────────

test('cancel: a technician can cancel their own PENDING upload; the sweeper cleans up and finalisation then does nothing', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const fileId = await pending(w, a)
  const del = (uid: string, body?: unknown, path = `/api/ops/technician/${w.job.id}/files/${fileId}`) => T(uid, 'DELETE', path, body)

  const r = await del(a.user.id, { workspaceId: w.ws.id })
  assert.equal(r.status, 200)
  assert.equal(r.body.file.status, 'REJECTED')
  assert.equal((await del(a.user.id, { workspaceId: w.ws.id })).status, 200, 'idempotent')
  const row = await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId } })
  assert.equal(row.status, 'REJECTED')
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'ops.technician.file.cancelled', entityId: fileId } }))

  const upload = await copy(fileId, 'upload')
  assert.ok(store.objects.has(upload.objectKey), 'the API itself never deletes objects')
  await sweepAbandonedEvidenceUploads({ store })
  assert.ok(!store.objects.has(upload.objectKey), 'the worker sweeper removes what is left')
  assert.deepEqual(await finalizeEvidenceFile({ workspaceId: w.ws.id, fileId }), { outcome: 'skipped', reason: 'status_rejected' })
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId } })).status, 'REJECTED')
})

test('cancel: scope may come from the query string; finished evidence and foreign files cannot be cancelled', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const a = await w.worker()
  const b = await w.worker()
  const done = await available(w, a)
  const mine = await pending(w, a)
  const url = (id: string, jobId = w.job.id) => `/api/ops/technician/${jobId}/files/${id}`

  assert.equal((await T(a.user.id, 'DELETE', url(done), { workspaceId: w.ws.id })).status, 409, 'AVAILABLE evidence is governed by C4, not removable here')
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: done } })).status, 'AVAILABLE')
  assert.equal((await T(b.user.id, 'DELETE', url(mine), { workspaceId: w.ws.id })).status, 404, "another technician's upload")
  assert.equal((await T(w.owner.id, 'DELETE', url(mine), { workspaceId: w.ws.id })).status, 403, 'a manager without a crew record cannot cancel')
  assert.equal((await T(other.owner.id, 'DELETE', url(mine), { workspaceId: w.ws.id })).status, 403)
  assert.equal((await T(null, 'DELETE', url(mine), { workspaceId: w.ws.id })).status, 401)
  assert.equal((await T(a.user.id, 'DELETE', url(mine))).status, 400, 'workspace scope required')
  assert.equal((await prisma.evidenceFile.findUniqueOrThrow({ where: { id: mine } })).status, 'PENDING')
  assert.equal((await T(a.user.id, 'DELETE', `${url(mine)}?workspaceId=${w.ws.id}`)).status, 200, 'query-string scope accepted')
})

test('cancel races finalisation: whichever wins, the file is never both', async () => {
  const w = await world('a@example.test')
  const a = await w.worker()
  const fileId = await pending(w, a)
  const [fin, del] = await Promise.all([
    finalizeEvidenceFile({ workspaceId: w.ws.id, fileId }),
    T(a.user.id, 'DELETE', `/api/ops/technician/${w.job.id}/files/${fileId}`, { workspaceId: w.ws.id }),
  ])
  const row = await prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId } })
  if (del.status === 200) {
    assert.equal(row.status, 'REJECTED')
    assert.notEqual(fin.outcome, 'finalized')
    // Anything finalisation published for the file has been removed or is swept.
    await sweepAbandonedEvidenceUploads({ store })
    const prim = await copy(fileId, 'primary')
    assert.ok(!store.objects.has(prim.objectKey), 'no orphaned final object for a cancelled file')
  } else {
    assert.equal(del.status, 409)
    assert.equal(row.status, 'AVAILABLE')
    assert.equal(fin.outcome, 'finalized')
  }
})
