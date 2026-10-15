// C2 security tests: evidence file upload initiation, completion and finalisation.
// Real PostgreSQL, real routes and worker processor, in-memory object store (no
// network, no credentials). The store enforces what a presigned PUT enforces.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import sharp from 'sharp'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { technicianFilesRouter, setFinalizeEnqueuerForTests } from '../apps/api/src/routes/ops/evidenceFiles.ts'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { finalizeEvidenceFile, sweepAbandonedEvidenceUploads } from '../apps/worker/src/processors/evidenceFinalize.ts'
import { MemoryEvidenceStore, setEvidenceStoreForTests } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { resolveEvidenceStorage } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

const ENV = {
  EVIDENCE_UPLOADS_ENABLED: 'true',
  EVIDENCE_S3_ENDPOINT: 'https://storage.example.test',
  EVIDENCE_S3_BUCKET: 'acaos-evidence-test',
  EVIDENCE_S3_ACCESS_KEY_ID: 'AKIATESTONLY',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'test-only-secret',
}
const ENV_KEYS = [...Object.keys(ENV), 'EVIDENCE_MAX_FILES_PER_JOB', 'EVIDENCE_MAX_PENDING_PER_WORKER', 'EVIDENCE_WORKSPACE_QUOTA_BYTES', 'EVIDENCE_MAX_UPLOAD_BYTES']
const saved: Record<string, string | undefined> = {}

let tech: TestServer
let delivery: TestServer
let store: MemoryEvidenceStore
let queued: Array<{ workspaceId: string; fileId: string }>

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  const combined = express.Router()
  combined.use(technicianRouter)
  combined.use(technicianFilesRouter)
  tech = await startTestServer('/api/ops/technician', combined)
  delivery = await startTestServer('/api/delivery', deliveryRouter)
})
after(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  setEvidenceStoreForTests(null)
  setFinalizeEnqueuerForTests(null)
  await tech.close(); await delivery.close(); await disconnect()
})
beforeEach(async () => {
  await resetDb()
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, ENV)
  store = new MemoryEvidenceStore()
  setEvidenceStoreForTests(store)
  queued = []
  setFinalizeEnqueuerForTests((async (o: { workspaceId: string; fileId: string }) => { queued.push(o); return {} }) as never)
})

// ── fixtures ────────────────────────────────────────────────────────────────

const solid = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })
const jpeg = () => solid().jpeg().toBuffer()
const jpegWithExif = () => solid().jpeg().withExif({
  IFD0: { Copyright: 'secret-owner-name' },
  IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' },
}).toBuffer()

function call(s: TestServer, userId: string | null, method: string, path: string, body?: unknown) {
  return s.request(path, {
    method,
    headers: { ...(userId ? { Authorization: bearer(userId) } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const T = (uid: string | null, method: string, path: string, body?: unknown) => call(tech, uid, method, path, body)

async function world(email: string) {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const newJob = () => prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const job = await newJob()
  let n = 0
  const worker = async (opts: { assign?: boolean; linked?: boolean; active?: boolean; job?: { id: string } } = {}) => {
    const user = await seedUser(`w${++n}-${Math.random().toString(36).slice(2, 6)}@example.test`)
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'member' } })
    const crew = opts.linked === false ? null : await prisma.opsCrewMember.create({ data: {
      workspaceId: workspace.id, employeeCode: `E${n}`, fullName: `W${n}`, role: 'TECH', userId: user.id, isActive: opts.active ?? true,
    } })
    if (crew && opts.assign !== false) {
      await prisma.jobTechnicianAssignment.create({ data: { workspaceId: workspace.id, jobId: (opts.job ?? job).id, crewMemberId: crew.id } })
    }
    return { user, crew }
  }
  return { owner, ws: workspace, site, job, newJob, worker }
}
type World = Awaited<ReturnType<typeof world>>

const initBody = (w: World, over: Record<string, unknown> = {}) => ({
  workspaceId: w.ws.id, submissionId: randomUUID(), contentType: 'image/jpeg', sizeBytes: 1000, ...over,
})
const initUrl = (jobId: string) => `/api/ops/technician/${jobId}/files/init`
const completeUrl = (jobId: string, fileId: string) => `/api/ops/technician/${jobId}/files/${fileId}/complete`
const statusUrl = (w: World, jobId: string, fileId: string) => `/api/ops/technician/${jobId}/files/${fileId}?workspaceId=${w.ws.id}`

/** init + the client's PUT, as a real client would do it. */
async function uploaded(w: World, t: { user: { id: string } }, bytes: Buffer, over: Record<string, unknown> = {}, jobId = w.job.id) {
  const init = await T(t.user.id, 'POST', initUrl(jobId), initBody(w, { sizeBytes: bytes.length, ...over }))
  assert.ok([200, 201].includes(init.status), `init: ${init.status} ${JSON.stringify(init.body)}`)
  const put = store.clientPut(init.body.upload.url, bytes, init.body.upload.headers)
  return { init, put, fileId: init.body.file.id as string }
}
const copies = (fileId: string) => prisma.evidenceFileCopy.findMany({ where: { fileId }, orderBy: { location: 'asc' } })
const fileRow = (fileId: string) => prisma.evidenceFile.findUniqueOrThrow({ where: { id: fileId } })
const fin = (w: World, fileId: string, extra: Record<string, unknown> = {}) =>
  finalizeEvidenceFile({ workspaceId: w.ws.id, fileId, ...extra })

// ── fail closed ─────────────────────────────────────────────────────────────

test('with the flag off every endpoint refuses and nothing is written', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  for (const flag of [undefined, 'false']) {
    if (flag === undefined) delete process.env.EVIDENCE_UPLOADS_ENABLED; else process.env.EVIDENCE_UPLOADS_ENABLED = flag
    assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 503)
    assert.equal((await T(t.user.id, 'POST', completeUrl(w.job.id, 'x'), { workspaceId: w.ws.id })).status, 503)
    assert.equal((await T(t.user.id, 'GET', statusUrl(w, w.job.id, 'x'))).status, 503)
  }
  assert.equal(await prisma.evidenceFile.count(), 0)
  assert.equal(store.calls.length, 0)
  const r = await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))
  assert.ok(!JSON.stringify(r.body).includes('AKIA'), 'no configuration detail in the response')
})

test('missing, invalid or half-configured storage also fails closed', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  for (const patch of [
    { EVIDENCE_S3_BUCKET: '' }, { EVIDENCE_S3_ENDPOINT: 'http://insecure.example.test' }, { EVIDENCE_S3_SECRET_ACCESS_KEY: '' },
    { EVIDENCE_UPLOADS_ENABLED: 'yes' }, { EVIDENCE_MAX_UPLOAD_BYTES: 'abc' },
  ]) {
    Object.assign(process.env, ENV, patch)
    const r = await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))
    assert.equal(r.status, 503, JSON.stringify(patch))
  }
  assert.equal(await prisma.evidenceFile.count(), 0)
})

test('the worker does nothing while uploads are disabled', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const bytes = await jpeg()
  const { fileId } = await uploaded(w, t, bytes)
  process.env.EVIDENCE_UPLOADS_ENABLED = 'false'
  store.calls = []
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'skipped', reason: 'uploads_disabled' })
  assert.deepEqual(await sweepAbandonedEvidenceUploads({ store }), { skipped: 'uploads_disabled' })
  assert.equal((await fileRow(fileId)).status, 'PENDING')
  assert.equal(store.calls.length, 0, 'storage untouched')
})

// ── initiation: authentication and authorisation ────────────────────────────

test('init authorisation matrix', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const assigned = await w.worker()
  const unassigned = await w.worker({ assign: false })
  const unlinked = await w.worker({ linked: false })
  const inactive = await w.worker({ active: false })
  const stranger = await seedUser('stranger@example.test')
  const url = initUrl(w.job.id)
  const sizeBody = (over: Record<string, unknown> = {}) => initBody(w, over)

  assert.equal((await T(null, 'POST', url, sizeBody())).status, 401, 'unauthenticated')
  assert.equal((await T(stranger.id, 'POST', url, sizeBody())).status, 403, 'not a member')
  assert.equal((await T(unlinked.user.id, 'POST', url, sizeBody())).status, 403, 'no crew link')
  assert.equal((await T(inactive.user.id, 'POST', url, sizeBody())).status, 403, 'inactive crew')
  assert.equal((await T(unassigned.user.id, 'POST', url, sizeBody())).status, 403, 'not assigned to this job')
  assert.equal((await T(w.owner.id, 'POST', url, sizeBody())).status, 403, 'a manager without a crew record is not a technician')
  // Cross-workspace: B's owner naming A's workspace, and A's worker naming B's job.
  assert.equal((await T(other.owner.id, 'POST', url, sizeBody())).status, 403, "B's user in A's workspace")
  assert.equal((await T(assigned.user.id, 'POST', initUrl(other.job.id), sizeBody())).status, 404, "A's worker, B's job under A's workspace id")
  assert.equal((await T(assigned.user.id, 'POST', initUrl(other.job.id), { ...sizeBody(), workspaceId: other.ws.id })).status, 403, "A's worker claiming B's workspace")
  assert.equal(await prisma.evidenceFile.count(), 0, 'nothing was created by any refused request')
  assert.equal((await T(assigned.user.id, 'POST', url, sizeBody())).status, 201)
})

test('revocation, job closure and deactivation stop new uploads', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 201)
  await prisma.jobTechnicianAssignment.deleteMany({ where: { jobId: w.job.id, crewMemberId: t.crew!.id } })
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 403, 'revoked')
  await prisma.jobTechnicianAssignment.create({ data: { workspaceId: w.ws.id, jobId: w.job.id, crewMemberId: t.crew!.id } })
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE' } })
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 409, 'job closed')
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'ACTIVE' } })
  await prisma.opsCrewMember.update({ where: { id: t.crew!.id }, data: { isActive: false } })
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 403, 'deactivated')
})

// ── initiation: validation, limits and forged input ─────────────────────────

test('declared type and size are validated; oversize and non-images are refused before anything is stored', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const post = (over: Record<string, unknown>) => T(t.user.id, 'POST', initUrl(w.job.id), initBody(w, over))
  for (const contentType of ['image/svg+xml', 'image/gif', 'image/heic', 'application/pdf', 'text/html', 'image/jpeg; charset=x', '']) {
    assert.equal((await post({ contentType })).status, 400, `type ${contentType}`)
  }
  for (const sizeBytes of [0, -1, 1.5, '1000', null, 'big']) assert.equal((await post({ sizeBytes })).status, 400, `size ${String(sizeBytes)}`)
  assert.equal((await post({ sizeBytes: 10 * 1024 * 1024 + 1 })).status, 413, 'above the configured maximum')
  assert.equal((await post({ submissionId: 'not-a-uuid' })).status, 400)
  assert.equal(await prisma.evidenceFile.count(), 0)
  process.env.EVIDENCE_MAX_UPLOAD_BYTES = '2048'
  assert.equal((await post({ sizeBytes: 2049 })).status, 413, 'configured limit applies')
  assert.equal((await post({ sizeBytes: 2048 })).status, 201)
})

test('an evidence link must be the technician’s own evidence on the same job and workspace', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const t1 = await w.worker()
  const t2 = await w.worker()
  const jobB = await w.newJob()
  const mk = (ws: string, job: string, crew: string) => prisma.jobTechnicianEvidence.create({ data: {
    workspaceId: ws, jobId: job, crewMemberId: crew, submissionId: randomUUID(), kind: 'NOTE', content: { note: 'n' } } })
  const mine = await mk(w.ws.id, w.job.id, t1.crew!.id)
  const theirs = await mk(w.ws.id, w.job.id, t2.crew!.id)
  await prisma.jobTechnicianAssignment.create({ data: { workspaceId: w.ws.id, jobId: jobB.id, crewMemberId: t1.crew!.id } })
  const otherTech = await other.worker()
  const foreign = await mk(other.ws.id, other.job.id, otherTech.crew!.id)
  const post = (evidenceId: string, job = w.job.id) => T(t1.user.id, 'POST', initUrl(job), initBody(w, { evidenceId }))
  assert.equal((await post(theirs.id)).status, 404, "another technician's evidence")
  assert.equal((await post(foreign.id)).status, 404, 'evidence from another workspace')
  assert.equal((await post(mine.id, jobB.id)).status, 404, 'evidence from a different job')
  assert.equal((await post('does-not-exist')).status, 404)
  assert.equal((await post(mine.id)).status, 201)
})

test('keys are unguessable, never returned, stay in the workspace, and URLs only work for their own object', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const bytes = await jpeg()
  const a = await uploaded(w, t, bytes)
  const b = await uploaded(w, t, bytes)
  const ca = await copies(a.fileId)
  const cb = await copies(b.fileId)
  for (const c of [...ca, ...cb]) assert.match(c.objectKey, new RegExp(`^ws/${w.ws.id}/job/${w.job.id}/(upload|final|thumb)/[A-Za-z0-9_-]{32}$`))
  assert.equal(new Set([...ca, ...cb].map(c => c.objectKey)).size, 6, 'all keys distinct (the thumb key shares its random part with the final key but is a different key)')
  const text = JSON.stringify(a.init.body)
  for (const c of ca) assert.ok(!text.includes(c.objectKey), 'object key not returned to the client')
  assert.deepEqual(a.init.body.upload.headers, { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length) })
  // A's URL wrote A's upload key and nothing else.
  assert.deepEqual([...store.objects.keys()].sort(), [ca.find(c => c.location === 'upload')!.objectKey, cb.find(c => c.location === 'upload')!.objectKey].sort())
})

test('forged size or type at upload time is refused by the storage signature', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const bytes = await jpeg()
  const init = await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w, { sizeBytes: bytes.length }))
  const { url, headers } = init.body.upload
  const bigger = Buffer.concat([bytes, Buffer.alloc(5000, 1)])
  assert.equal(store.clientPut(url, bigger, { ...headers, 'Content-Length': String(bigger.length) }).status, 403, 'larger than declared')
  assert.equal(store.clientPut(url, bytes.subarray(0, 10), { ...headers, 'Content-Length': '10' }).status, 403, 'smaller than declared')
  assert.equal(store.clientPut(url, bytes, { ...headers, 'Content-Type': 'text/html' }).status, 403, 'different content type')
  assert.equal(store.objects.size, 0)
  // Nothing arrived, so completing is refused and nothing is queued.
  const c = await T(t.user.id, 'POST', completeUrl(w.job.id, init.body.file.id), { workspaceId: w.ws.id })
  assert.equal(c.status, 409)
  assert.equal(queued.length, 0)
  store.now = () => Date.now() + 10 * 60_000
  assert.equal(store.clientPut(url, bytes, headers).status, 403, 'expired link')
})

test('per-job, per-technician and per-workspace limits are enforced', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  process.env.EVIDENCE_MAX_FILES_PER_JOB = '2'
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 201)
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 201)
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 409, 'job file cap')
  process.env.EVIDENCE_MAX_FILES_PER_JOB = '100'
  process.env.EVIDENCE_MAX_PENDING_PER_WORKER = '2'
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))).status, 429, 'unfinished-upload cap')
  const w2 = await world('b@example.test')
  const t2 = await w2.worker()
  process.env.EVIDENCE_MAX_PENDING_PER_WORKER = '10'
  process.env.EVIDENCE_WORKSPACE_QUOTA_BYTES = String(1024 * 1024)
  assert.equal((await T(t2.user.id, 'POST', initUrl(w2.job.id), initBody(w2, { sizeBytes: 600 * 1024 }))).status, 201)
  assert.equal((await T(t2.user.id, 'POST', initUrl(w2.job.id), initBody(w2, { sizeBytes: 600 * 1024 }))).status, 409, 'workspace quota')
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w, { sizeBytes: 1 }))).status, 201, "workspace A is unaffected by workspace B's full quota")
})

// ── idempotency and races at initiation ─────────────────────────────────────

test('repeating an init is idempotent; changing it is a conflict', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const body = initBody(w, { sizeBytes: 5000 })
  const first = await T(t.user.id, 'POST', initUrl(w.job.id), body)
  const again = await T(t.user.id, 'POST', initUrl(w.job.id), body)
  assert.equal(first.status, 201)
  assert.equal(again.status, 200)
  assert.equal(again.body.file.id, first.body.file.id)
  assert.ok(again.body.upload.url, 'a fresh link is issued for an unfinished upload')
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), { ...body, sizeBytes: 5001 })).status, 409)
  assert.equal((await T(t.user.id, 'POST', initUrl(w.job.id), { ...body, contentType: 'image/png' })).status, 409)
  assert.equal(await prisma.evidenceFile.count(), 1)
  assert.equal(await prisma.evidenceFileCopy.count(), 3)
  // The same submission id from another technician is unrelated.
  const t2 = await w.worker()
  assert.equal((await T(t2.user.id, 'POST', initUrl(w.job.id), body)).status, 201)
})

test('concurrent inits for one submission create exactly one file', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const body = initBody(w, { sizeBytes: 4000 })
  const rs = await Promise.all(Array.from({ length: 8 }, () => T(t.user.id, 'POST', initUrl(w.job.id), body)))
  assert.equal(rs.filter(r => r.status === 201).length, 1, JSON.stringify(rs.map(r => r.status)))
  assert.equal(rs.filter(r => r.status === 200).length, 7)
  assert.equal(new Set(rs.map(r => r.body.file.id)).size, 1)
  assert.equal(await prisma.evidenceFile.count(), 1)
})

// ── completion ──────────────────────────────────────────────────────────────

test('complete: owner-only, requires the object, queues once the upload exists, and is repeatable', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const t1 = await w.worker()
  const t2 = await w.worker()
  const bytes = await jpeg()
  const { fileId } = await uploaded(w, t1, bytes)
  const body = { workspaceId: w.ws.id }
  assert.equal((await T(null, 'POST', completeUrl(w.job.id, fileId), body)).status, 401)
  assert.equal((await T(t2.user.id, 'POST', completeUrl(w.job.id, fileId), body)).status, 404, "another technician's file on the same job")
  assert.equal((await T(other.owner.id, 'POST', completeUrl(w.job.id, fileId), body)).status, 403, 'other workspace')
  assert.equal((await T(t1.user.id, 'POST', completeUrl(other.job.id, fileId), body)).status, 404, 'wrong job')
  assert.equal(queued.length, 0)
  const ok = await T(t1.user.id, 'POST', completeUrl(w.job.id, fileId), body)
  assert.equal(ok.status, 202)
  assert.deepEqual(queued, [{ workspaceId: w.ws.id, fileId }])
  assert.equal((await T(t1.user.id, 'POST', completeUrl(w.job.id, fileId), body)).status, 202, 'repeat is harmless')
  // Closed job / revoked assignment cannot complete.
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE' } })
  assert.equal((await T(t1.user.id, 'POST', completeUrl(w.job.id, fileId), body)).status, 409)
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'ACTIVE' } })
  await prisma.jobTechnicianAssignment.deleteMany({ where: { jobId: w.job.id, crewMemberId: t1.crew!.id } })
  assert.equal((await T(t1.user.id, 'POST', completeUrl(w.job.id, fileId), body)).status, 403)
  assert.equal((await fileRow(fileId)).status, 'PENDING', 'the API never makes a file AVAILABLE')
})

// ── finalisation ────────────────────────────────────────────────────────────

test('finalise: sanitised, EXIF/GPS stripped, raw upload removed, checksum recorded, and fully idempotent', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const raw = await jpegWithExif()
  assert.ok(raw.includes('secret-owner-name'))
  const { fileId } = await uploaded(w, t, raw)
  const all = await copies(fileId)
  const primary = all.find((c) => c.location === 'primary')!
  const upload = all.find((c) => c.location === 'upload')!
  assert.equal(upload.location, 'upload')
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'finalized' })
  const f = await fileRow(fileId)
  assert.equal(f.status, 'AVAILABLE')
  assert.equal(f.contentType, 'image/jpeg')
  assert.ok(f.finalizedAt && f.sha256 && f.sizeBytes)
  const stored = store.objects.get(primary.objectKey)!.bytes
  assert.equal(stored.length, f.sizeBytes)
  assert.ok(!stored.includes('secret-owner-name') && !stored.includes('GPS'), 'metadata stripped from what is stored')
  assert.equal((await sharp(stored).metadata()).exif, undefined)
  assert.equal(store.objects.has(upload.objectKey), false, 'raw upload deleted')
  const after = await copies(fileId)
  assert.equal(after.find(c => c.location === 'primary')!.status, 'VERIFIED')
  assert.equal(after.find(c => c.location === 'primary')!.sha256, f.sha256)
  assert.equal(after.find(c => c.location === 'upload')!.status, 'DELETED')
  // Retries and duplicates are no-ops.
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'already_final' })
  assert.equal(store.objects.size, 2, 'final object + thumbnail')
  const status = await T(t.user.id, 'GET', statusUrl(w, w.job.id, fileId))
  assert.equal(status.status, 200)
  assert.equal(status.body.file.status, 'AVAILABLE')
  assert.ok(!JSON.stringify(status.body).includes(primary.objectKey), 'status never exposes keys')
})

test('concurrent finalisers produce exactly one AVAILABLE file and leave no stray objects', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const { fileId } = await uploaded(w, t, await jpeg())
  const results = await Promise.all(Array.from({ length: 5 }, () => fin(w, fileId, { store })))
  assert.ok(results.filter(r => r.outcome === 'finalized').length >= 1)
  assert.ok(results.every(r => ['finalized', 'already_final', 'skipped'].includes(r.outcome)), JSON.stringify(results))
  assert.equal((await fileRow(fileId)).status, 'AVAILABLE')
  const keys = [...store.objects.keys()]
  assert.equal(keys.length, 2, `only the final object and its thumbnail remain: ${keys}`)
  assert.deepEqual(keys.map((k) => k.split('/').slice(-2, -1)[0]).sort(), ['final', 'thumb'])
})

test('forged or hostile content is rejected by the worker and every object is removed', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const png = await solid().png().toBuffer()
  const cases: Array<[string, Buffer, string, string]> = [
    ['png bytes declared as jpeg', png, 'image/jpeg', 'type_mismatch'],
    ['html declared as jpeg', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg', 'unsupported_type'],
    ['svg declared as png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>'), 'image/png', 'unsupported_type'],
    ['script declared as webp', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'image/webp', 'unsupported_type'],
    ['truncated jpeg', (await jpeg()).subarray(0, 120), 'image/jpeg', 'decode_failed'],
    ['jpeg header + garbage', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]), 'image/jpeg', 'decode_failed'],
  ]
  for (const [label, bytes, declared, reason] of cases) {
    const { fileId } = await uploaded(w, t, bytes, { contentType: declared })
    assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'rejected', reason }, label)
    assert.equal((await fileRow(fileId)).status, 'REJECTED', label)
    assert.ok((await copies(fileId)).every(c => c.status === 'DELETED'), `${label}: copies marked deleted`)
  }
  assert.equal(store.objects.size, 0, 'nothing left in storage')
})

test('a pixel bomb and an object that is not the size that was signed are rejected', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const cfg = (resolveEvidenceStorage(process.env) as { enabled: true; config: Record<string, number> }).config
  const bomb = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#000' } }).png().toBuffer()
  const a = await uploaded(w, t, bomb, { contentType: 'image/png' })
  assert.deepEqual(await fin(w, a.fileId, { store, config: { ...cfg, maxPixels: 1_000_000 } as never }), { outcome: 'rejected', reason: 'too_many_pixels' })
  // Object replaced after the upload with something of a different size.
  const b = await uploaded(w, t, await jpeg())
  const bu = (await copies(b.fileId)).find(c => c.location === 'upload')!
  store.objects.set(bu.objectKey, { bytes: Buffer.alloc(77, 1), contentType: 'image/jpeg' })
  assert.deepEqual(await fin(w, b.fileId, { store }), { outcome: 'rejected', reason: 'size_mismatch' })
  // Object larger than the configured maximum (e.g. limit lowered after init).
  const c = await uploaded(w, t, await jpeg())
  assert.deepEqual(await fin(w, c.fileId, { store, config: { ...cfg, maxUploadBytes: 10 } as never }), { outcome: 'rejected', reason: 'too_large' })
  // Upload never arrived.
  const init = await T(t.user.id, 'POST', initUrl(w.job.id), initBody(w))
  assert.deepEqual(await fin(w, init.body.file.id, { store }), { outcome: 'rejected', reason: 'upload_missing' })
  assert.equal(store.objects.size, 0)
})

test('an appended payload does not survive finalisation', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const poly = Buffer.concat([await jpeg(), Buffer.from('<?php system($_GET["c"]); ?>EVIL-ZIP-PAYLOAD')])
  const { fileId } = await uploaded(w, t, poly)
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'finalized' })
  const primary = (await copies(fileId)).find(c => c.location === 'primary')!
  assert.ok(!store.objects.get(primary.objectKey)!.bytes.includes('EVIL-ZIP-PAYLOAD'))
})

// ── the worker cannot finalise after closure, revocation or deactivation ─────

test('closure, revocation and deactivation before finalisation reject the file', async () => {
  const w = await world('a@example.test')
  const cases: Array<[string, (j: { id: string }, crewId: string) => Promise<unknown>, string]> = [
    ['job closed', (j) => prisma.job.update({ where: { id: j.id }, data: { status: 'COMPLETE' } }), 'job_closed'],
    ['assignment revoked', (j, c) => prisma.jobTechnicianAssignment.deleteMany({ where: { jobId: j.id, crewMemberId: c } }), 'assignment_revoked'],
    ['technician deactivated', (_j, c) => prisma.opsCrewMember.update({ where: { id: c }, data: { isActive: false } }), 'crew_inactive'],
  ]
  for (const [label, act, reason] of cases) {
    const job = await w.newJob()
    const t = await w.worker({ job })
    const { fileId } = await uploaded(w, t, await jpeg(), {}, job.id)
    await act(job, t.crew!.id)
    assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'rejected', reason }, label)
    assert.equal((await fileRow(fileId)).status, 'REJECTED', label)
  }
  assert.equal(store.objects.size, 0, 'no object survives a rejection')
  assert.equal(await prisma.evidenceFile.count({ where: { status: 'AVAILABLE' } }), 0)
})

test('a closeout that lands while the worker is processing wins: nothing becomes AVAILABLE and the published object is removed', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const { fileId } = await uploaded(w, t, await jpeg())
  store.onPut = async (key) => { if (key.includes('/final/')) await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE' } }) }
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'rejected', reason: 'job_closed' })
  assert.equal((await fileRow(fileId)).status, 'REJECTED')
  assert.equal(store.objects.size, 0)
})

test('the real closeout route racing finalisation never leaves an AVAILABLE file on a closed job, nor orphan objects', async () => {
  const w = await world('a@example.test')
  for (let round = 0; round < 6; round++) {
    const job = await w.newJob()
    const t = await w.worker({ job })
    const { fileId } = await uploaded(w, t, await jpeg(), {}, job.id)
    const [closed, result] = await Promise.all([
      call(delivery, w.owner.id, 'POST', `/api/delivery/jobs/${job.id}/closeout`, { workspaceId: w.ws.id }),
      fin(w, fileId, { store }),
    ])
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.ok(['finalized', 'rejected'].includes(result.outcome), JSON.stringify(result))
    const f = await fileRow(fileId)
    const keys = [...store.objects.keys()].filter(k => k.includes(`/job/${job.id}/`))
    if (f.status === 'AVAILABLE') {
      assert.equal(keys.length, 1, 'finalised before the closeout: exactly the final object')
      assert.ok(keys[0].includes('/final/'))
    } else {
      assert.equal(f.status, 'REJECTED')
      assert.equal(keys.length, 0, 'rejected: no object left behind')
    }
    // Whatever happened, afterwards nothing can be finalised on the closed job.
    assert.equal((await T(t.user.id, 'POST', initUrl(job.id), initBody(w))).status, 409)
  }
})

test('revocation racing finalisation is consistent', async () => {
  const w = await world('a@example.test')
  for (let round = 0; round < 6; round++) {
    const job = await w.newJob()
    const t = await w.worker({ job })
    const { fileId } = await uploaded(w, t, await jpeg(), {}, job.id)
    const [revoked] = await Promise.all([
      T(w.owner.id, 'DELETE', `/api/ops/technician/${job.id}/assignments/${t.crew!.id}?workspaceId=${w.ws.id}`),
      fin(w, fileId, { store }),
    ])
    assert.equal(revoked.status, 200)
    const f = await fileRow(fileId)
    const keys = [...store.objects.keys()].filter(k => k.includes(`/job/${job.id}/`))
    assert.ok(['AVAILABLE', 'REJECTED'].includes(f.status))
    assert.equal(keys.length, f.status === 'AVAILABLE' ? 1 : 0)
    assert.deepEqual(await fin(w, fileId, { store }).then(r => r.outcome), f.status === 'AVAILABLE' ? 'already_final' : 'skipped')
  }
})

test('a file that does not exist in this workspace (including a deleted workspace) is skipped', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const t = await w.worker()
  const { fileId } = await uploaded(w, t, await jpeg())
  assert.deepEqual(await finalizeEvidenceFile({ workspaceId: other.ws.id, fileId, store }), { outcome: 'skipped', reason: 'not_found' }, 'a file id from another workspace')
  assert.deepEqual(await finalizeEvidenceFile({ workspaceId: 'gone-workspace', fileId: 'gone-file', store }), { outcome: 'skipped', reason: 'not_found' })
  assert.equal((await fileRow(fileId)).status, 'PENDING')
})

// ── retries ─────────────────────────────────────────────────────────────────

test('a transient storage failure is retried safely; the final attempt rejects and cleans up', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const { fileId } = await uploaded(w, t, await jpeg())
  store.failNext = { op: 'getBytes', times: 1 }
  await assert.rejects(fin(w, fileId, { store }), /injected getBytes failure/)
  assert.equal((await fileRow(fileId)).status, 'PENDING', 'left for the retry')
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'finalized' })

  const b = await uploaded(w, t, await jpeg())
  store.failNext = { op: 'putBytes', times: 99 }
  await assert.rejects(fin(w, b.fileId, { store }), /injected putBytes failure/)
  assert.deepEqual(await fin(w, b.fileId, { store, lastAttempt: true }), { outcome: 'rejected', reason: 'processing_failed' })
  store.failNext = null
  assert.equal((await fileRow(b.fileId)).status, 'REJECTED')
  assert.equal([...store.objects.keys()].filter(k => k.includes('/upload/')).length, 0, 'raw upload removed')
})

// ── abandoned and orphaned uploads ──────────────────────────────────────────

test('the sweeper rejects abandoned uploads and clears leftovers, idempotently, without touching live ones', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const old = await uploaded(w, t, await jpeg())
  const fresh = await uploaded(w, t, await jpeg())
  const done = await uploaded(w, t, await jpeg())
  await fin(w, done.fileId, { store })
  await prisma.evidenceFile.update({ where: { id: old.fileId }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } })
  const r1 = await sweepAbandonedEvidenceUploads({ store })
  assert.deepEqual(r1, { rejected: 1, copiesCleaned: 0, lateUploadsRemoved: 0 }, 'rejection removes the objects itself; there are no leftovers')
  assert.equal((await fileRow(old.fileId)).status, 'REJECTED')
  assert.ok((await copies(old.fileId)).every(c => c.status === 'DELETED'), 'abandoned upload cleaned up')
  const oldKeys = (await copies(old.fileId)).map(c => c.objectKey)
  assert.ok(oldKeys.every(k => !store.objects.has(k)), 'and its objects are gone')
  assert.equal((await fileRow(fresh.fileId)).status, 'PENDING', 'a recent upload is left alone')
  assert.equal((await fileRow(done.fileId)).status, 'AVAILABLE')
  assert.deepEqual(await sweepAbandonedEvidenceUploads({ store }), { rejected: 0, copiesCleaned: 0, lateUploadsRemoved: 0 }, 'second sweep is a no-op')

  // A delete that failed leaves the copy behind; the next sweep removes it.
  const doomed = await uploaded(w, t, await jpeg())
  await prisma.evidenceFile.update({ where: { id: doomed.fileId }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } })
  store.failNext = { op: 'delete', times: 99 }
  await sweepAbandonedEvidenceUploads({ store })
  store.failNext = null
  assert.equal((await fileRow(doomed.fileId)).status, 'REJECTED')
  assert.ok((await copies(doomed.fileId)).some(c => c.status !== 'DELETED'), 'a copy is still recorded as present')
  const r3 = await sweepAbandonedEvidenceUploads({ store })
  assert.ok('copiesCleaned' in r3 && r3.copiesCleaned >= 1)
  assert.ok((await copies(doomed.fileId)).every(c => c.status === 'DELETED'))
  const doomedKeys = (await copies(doomed.fileId)).map(c => c.objectKey)
  assert.ok([...store.objects.keys()].every(k => !doomedKeys.includes(k)), 'its objects are gone')
})

// ── status endpoint ─────────────────────────────────────────────────────────

test('file status is visible to the owner and workspace managers only', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const t1 = await w.worker()
  const t2 = await w.worker()
  const { fileId } = await uploaded(w, t1, await jpeg())
  assert.equal((await T(t1.user.id, 'GET', statusUrl(w, w.job.id, fileId))).status, 200)
  assert.equal((await T(w.owner.id, 'GET', statusUrl(w, w.job.id, fileId))).status, 200, 'manager')
  assert.equal((await T(t2.user.id, 'GET', statusUrl(w, w.job.id, fileId))).status, 404, 'another technician')
  assert.equal((await T(other.owner.id, 'GET', statusUrl(w, w.job.id, fileId))).status, 403, 'other workspace manager')
  assert.equal((await T(other.owner.id, 'GET', `/api/ops/technician/${w.job.id}/files/${fileId}?workspaceId=${other.ws.id}`)).status, 404, 'own workspace id, foreign file')
  assert.equal((await T(null, 'GET', statusUrl(w, w.job.id, fileId))).status, 401)
})

test('a signed URL reused after finalisation cannot leave an untracked object behind', async () => {
  const w = await world('a@example.test')
  const t = await w.worker()
  const bytes = await jpeg()
  const { init, fileId } = await uploaded(w, t, bytes)
  assert.deepEqual(await fin(w, fileId, { store }), { outcome: 'finalized' })
  const rawKey = (await copies(fileId)).find(c => c.location === 'upload')!.objectKey
  assert.equal(store.objects.has(rawKey), false, 'raw object deleted at finalisation')
  // The link is still within its lifetime, so the client can PUT again.
  assert.equal(store.clientPut(init.body.upload.url, bytes, init.body.upload.headers).status, 200)
  assert.equal(store.objects.has(rawKey), true, 'an object the database does not track')
  // Too early (the link could still be used again): left alone.
  const early = await sweepAbandonedEvidenceUploads({ store })
  assert.ok('lateUploadsRemoved' in early && early.lateUploadsRemoved === 0)
  // Once the link has certainly expired, the next sweep removes it.
  const later = await sweepAbandonedEvidenceUploads({ store, now: new Date(Date.now() + 10 * 60_000) })
  assert.ok('lateUploadsRemoved' in later && later.lateUploadsRemoved === 1, JSON.stringify(later))
  assert.equal(store.objects.has(rawKey), false)
  assert.equal((await fileRow(fileId)).status, 'AVAILABLE', 'the finalised file is untouched')
  assert.equal([...store.objects.keys()].filter(k => k.includes('/final/')).length, 1)
})
