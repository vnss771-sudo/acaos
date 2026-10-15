// C5d tests: the manager evidence gallery reads photos through the C5a endpoints and finds the Job
// (not the site) through the delivery job list. Real PostgreSQL (tenant guard enforcing), real routes
// and worker finalisation, in-memory object store that mimics provider behaviour.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import sharp from 'sharp'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { technicianFilesRouter, setFinalizeEnqueuerForTests } from '../apps/api/src/routes/ops/evidenceFiles.ts'
import { deliveryRouter } from '../apps/api/src/routes/delivery.ts'
import { finalizeEvidenceFile } from '../apps/worker/src/processors/evidenceFinalize.ts'
import { invalidateWorkspaceMembership } from '../apps/api/src/lib/workspaces.ts'
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
let delivery: TestServer
let store: MemoryEvidenceStore

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
  Object.assign(process.env, ENV)
  store = new MemoryEvidenceStore()
  setEvidenceStoreForTests(store)
  setFinalizeEnqueuerForTests((async () => ({})) as never)
})

const photo = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).jpeg().toBuffer()
const call = (srv: TestServer) => (uid: string | null, method: string, path: string, body?: unknown) => srv.request(path, {
  method,
  headers: { ...(uid ? { Authorization: bearer(uid) } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const T = (uid: string | null, method: string, path: string, body?: unknown) => call(tech)(uid, method, path, body)
const D = (uid: string | null, path: string) => call(delivery)(uid, 'GET', path)

let n = 0
async function world(email: string) {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: `S${++n}`, siteName: 'Site' } })
  // One site, two Jobs: the gallery is per Job, never merged per site.
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const otherJob = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const user = await seedUser(`w${++n}-${Math.random().toString(36).slice(2, 6)}@example.test`)
  await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'member' } })
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: `E${n}`, fullName: `Worker ${n}`, role: 'TECH', userId: user.id, isActive: true } })
  for (const j of [job, otherJob]) await prisma.jobTechnicianAssignment.create({ data: { workspaceId: workspace.id, jobId: j.id, crewMemberId: crew.id } })
  return { owner, ws: workspace, job, otherJob, tech: { user, crew } }
}
type World = Awaited<ReturnType<typeof world>>

async function available(w: World, jobId = w.job.id): Promise<string> {
  const b = await photo()
  const init = await T(w.tech.user.id, 'POST', `/api/ops/technician/${jobId}/files/init`,
    { workspaceId: w.ws.id, submissionId: randomUUID(), contentType: 'image/jpeg', sizeBytes: b.length })
  assert.equal(init.status, 201, JSON.stringify(init.body))
  assert.equal(store.clientPut(init.body.upload.url, b, init.body.upload.headers).status, 200)
  const fileId = init.body.file.id as string
  assert.equal((await finalizeEvidenceFile({ workspaceId: w.ws.id, fileId })).outcome, 'finalized')
  return fileId
}
const list = (w: World, jobId = w.job.id, ws = w.ws.id) => `/api/ops/technician/${jobId}/files?workspaceId=${ws}&limit=24`
const content = (w: World, fileId: string, variant = 'thumb', jobId = w.job.id, ws = w.ws.id) => `/api/ops/technician/${jobId}/files/${fileId}/content?workspaceId=${ws}&variant=${variant}`

test('the delivery job list reports only the server capability, and the gallery is per Job within a site', async () => {
  const w = await world('a@example.test')
  const on = await D(w.owner.id, `/api/delivery/jobs?workspaceId=${w.ws.id}`)
  assert.equal(on.status, 200)
  assert.equal(on.body.evidencePhotos, true)
  assert.equal(on.body.jobs.length, 2, 'two Jobs on one site are listed separately')
  assert.ok(on.body.jobs.every((j: { site: { id: string } }) => j.site.id === on.body.jobs[0].site.id))

  const f1 = await available(w, w.job.id)
  await available(w, w.otherJob.id)
  const mine = (await T(w.owner.id, 'GET', list(w, w.job.id))).body.files
  assert.deepEqual(mine.map((f: { id: string }) => f.id), [f1], "a Job's gallery holds only that Job's photos")
  assert.equal(mine[0].uploadedBy.name, w.tech.crew.fullName)

  delete process.env.EVIDENCE_UPLOADS_ENABLED
  const off = await D(w.owner.id, `/api/delivery/jobs?workspaceId=${w.ws.id}`)
  assert.equal(off.body.evidencePhotos, false, 'production default: no gallery offered')
  assert.equal((await T(w.owner.id, 'GET', list(w))).status, 503, 'and the read endpoints fail closed')
})

test('only managers get the capability flag, and it leaks nothing about other workspaces', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  assert.equal((await D(w.tech.user.id, `/api/delivery/jobs?workspaceId=${w.ws.id}`)).status, 403, 'a technician cannot list delivery jobs')
  assert.equal((await D(other.owner.id, `/api/delivery/jobs?workspaceId=${w.ws.id}`)).status, 403)
  assert.equal((await D(null, `/api/delivery/jobs?workspaceId=${w.ws.id}`)).status, 401)
})

test('cross-workspace isolation: a manager of another workspace sees and signs nothing, by any route', async () => {
  const w = await world('a@example.test')
  const other = await world('b@example.test')
  const fileId = await available(w)
  const foreign = await available(other)
  // Another workspace's manager, naming their own workspace or ours.
  assert.equal((await T(other.owner.id, 'GET', list(w, w.job.id, other.ws.id))).status, 404, 'our job id under their workspace is a missing job')
  assert.equal((await T(other.owner.id, 'GET', list(w))).status, 403, 'our workspace: not a member')
  assert.equal((await T(other.owner.id, 'GET', content(w, fileId, 'full', w.job.id, other.ws.id))).status, 404)
  assert.equal((await T(other.owner.id, 'GET', content(w, fileId))).status, 403)
  // Our manager cannot reach their file by mixing identifiers.
  assert.equal((await T(w.owner.id, 'GET', content(w, foreign))).status, 404, "another workspace's file id")
  assert.equal((await T(w.owner.id, 'GET', content(other, foreign, 'full', other.job.id, w.ws.id))).status, 404)
  assert.equal((await T(w.owner.id, 'GET', content(w, fileId, 'full', other.job.id))).status, 404, 'right file, other workspace\'s job')
  // And the answers never carry storage details.
  const ok = await T(w.owner.id, 'GET', content(w, fileId))
  assert.equal(ok.status, 200)
  assert.ok(!/ws\/|objectKey|bucket/i.test(JSON.stringify(ok.body).replace(ok.body.url, '')))
})

test('access revocation takes effect on the next request: demoted or removed managers lose list and content', async () => {
  const w = await world('a@example.test')
  const admin = await seedUser(`m${++n}@example.test`)
  const m = await prisma.membership.create({ data: { workspaceId: w.ws.id, userId: admin.id, role: 'admin' } })
  const fileId = await available(w)
  assert.equal((await T(admin.id, 'GET', list(w))).status, 200)
  assert.equal((await T(admin.id, 'GET', content(w, fileId))).status, 200)

  // The app's membership routes drop the cached role on every change (members.ts); do the same here.
  // A direct database edit that skips this is bounded by the 5 s role-cache TTL (see C5D doc).
  await prisma.membership.update({ where: { id: m.id }, data: { role: 'member' } })
  invalidateWorkspaceMembership(admin.id, w.ws.id)
  assert.equal((await T(admin.id, 'GET', list(w))).status, 403, 'demoted: not a manager, not assigned')
  assert.equal((await T(admin.id, 'GET', content(w, fileId))).status, 403)

  await prisma.membership.update({ where: { id: m.id }, data: { role: 'admin' } })
  invalidateWorkspaceMembership(admin.id, w.ws.id)
  assert.equal((await T(admin.id, 'GET', list(w))).status, 200, 'sanity: the role is what decides')
  await prisma.membership.delete({ where: { id: m.id } })
  invalidateWorkspaceMembership(admin.id, w.ws.id)
  assert.equal((await T(admin.id, 'GET', list(w))).status, 403, 'removed from the workspace')
  assert.equal((await T(admin.id, 'GET', content(w, fileId))).status, 403)
})

test('signed links expire in 60 seconds or less, and asking again gives a fresh working link', async () => {
  const w = await world('a@example.test')
  const fileId = await available(w)
  for (const variant of ['thumb', 'full']) {
    const first = await T(w.owner.id, 'GET', content(w, fileId, variant))
    assert.equal(first.status, 200)
    const ttl = new Date(first.body.expiresAt).getTime() - Date.now()
    assert.ok(ttl > 0 && ttl <= 60_000)
    assert.equal(store.clientGet(first.body.url).status, 200)
    store.now = () => Date.now() + 61_000
    assert.equal(store.clientGet(first.body.url).status, 403, `${variant}: the old link is dead`)
    const again = await T(w.owner.id, 'GET', content(w, fileId, variant))
    assert.equal(again.status, 200)
    assert.notEqual(again.body.url, first.body.url)
    assert.equal(store.clientGet(again.body.url).status, 200, `${variant}: the new link works`)
    store.now = () => Date.now()
  }
})

test('unavailable evidence is never listed or signed for a manager, and a missing thumbnail falls back cleanly', async () => {
  const w = await world('a@example.test')
  const ok = await available(w)
  const rejected = await available(w)
  const deleting = await available(w)
  const deleted = await available(w)
  const unverified = await available(w)
  await prisma.evidenceFile.update({ where: { id: rejected }, data: { status: 'REJECTED' } })
  await prisma.evidenceFile.update({ where: { id: deleting }, data: { status: 'DELETING' } })
  await prisma.evidenceFile.update({ where: { id: deleted }, data: { status: 'DELETED', deletedAt: new Date() } })
  await prisma.evidenceFileCopy.updateMany({ where: { fileId: unverified, location: 'primary' }, data: { status: 'PENDING' } })

  const l = await T(w.owner.id, 'GET', list(w))
  const ids = l.body.files.map((f: { id: string }) => f.id)
  assert.ok(ids.includes(ok))
  for (const gone of [rejected, deleting, deleted]) {
    assert.ok(!ids.includes(gone), 'not listed')
    assert.equal((await T(w.owner.id, 'GET', content(w, gone, 'full'))).status, 409, 'not signed')
    assert.equal((await T(w.owner.id, 'GET', content(w, gone, 'thumb'))).status, 409)
  }
  assert.equal((await T(w.owner.id, 'GET', content(w, unverified, 'full'))).status, 404, 'primary object not verified: nothing to sign')

  // A file without a verified thumbnail still lists (hasThumb=false) and its full image still signs.
  await prisma.evidenceFileCopy.updateMany({ where: { fileId: ok, location: 'thumb' }, data: { status: 'PENDING' } })
  const row = (await T(w.owner.id, 'GET', list(w))).body.files.find((f: { id: string }) => f.id === ok)
  assert.equal(row.hasThumb, false)
  assert.equal((await T(w.owner.id, 'GET', content(w, ok, 'thumb'))).status, 404)
  assert.equal((await T(w.owner.id, 'GET', content(w, ok, 'full'))).status, 200)
})

test('pagination for the gallery: newest first, stable across pages, no duplicates, 24 per page', async () => {
  const w = await world('a@example.test')
  const made: string[] = []
  for (let i = 0; i < 5; i++) made.push(await available(w))
  const seen: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 5; guard++) {
    const r: { status: number; body: { files: Array<{ id: string }>; nextCursor: string | null } } =
      await T(w.owner.id, 'GET', `/api/ops/technician/${w.job.id}/files?workspaceId=${w.ws.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
    assert.equal(r.status, 200)
    seen.push(...r.body.files.map((f) => f.id))
    cursor = r.body.nextCursor
    if (!cursor) break
  }
  assert.deepEqual(seen, [...made].reverse(), 'newest first, each exactly once')
  assert.equal((await T(w.owner.id, 'GET', list(w))).status, 200, 'the gallery page size (24) is accepted')
})
