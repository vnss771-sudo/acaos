// The C5b upload engine end to end, in a REAL browser against the REAL API, database, presigner and
// an S3-compatible server: real Chromium, real IndexedDB queue, real XHR PUT to the signed URL, the
// real routes (tenant guard enforcing), and the real finalisation worker code run in-process.
//
// Opt-in (needs a disposable S3-compatible server and a Chromium build):
//   ACAOS_S3_IT=1 plus the EVIDENCE_S3_* variables from docs/runbooks/EVIDENCE_RESTORE_DRILL.md
//   (loopback endpoint), and ACAOS_CHROMIUM=/path/to/chrome if Playwright's own build is not installed.
// Nothing here touches a real provider account.
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import sharp from 'sharp'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { S3Client, PutBucketCorsCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { technicianRouter } from '../apps/api/src/routes/ops/technician.ts'
import { technicianFilesRouter, setFinalizeEnqueuerForTests } from '../apps/api/src/routes/ops/evidenceFiles.ts'
import { finalizeEvidenceFile, sweepAbandonedEvidenceUploads } from '../apps/worker/src/processors/evidenceFinalize.ts'
import { resolveEvidenceStorage } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import { getEvidenceStore, setEvidenceStoreForTests } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { signJwt } from '../packages/backend-core/src/lib/jwt.ts'
import { evidenceBundle } from '../e2e/evidenceBundle.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, startTestServer, type TestServer } from './helpers/db.ts'

const ENABLED = process.env.ACAOS_S3_IT === '1'
const it = (name: string, fn: () => Promise<void>) => test(name, { skip: !ENABLED && 'set ACAOS_S3_IT=1 with a disposable S3 server and Chromium' }, fn)
const PAGE_PORT = 5200
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`

let api: TestServer
let pageServer: http.Server
let browser: Browser
let ctx: BrowserContext
let page: Page
let bundle = ''
let queued: Array<{ workspaceId: string; fileId: string }> = []
let blocked = false
let workerTimer: ReturnType<typeof setInterval> | null = null
const cfg = ENABLED ? resolveEvidenceStorage() : null
const store = () => { if (!cfg?.enabled) throw new Error('storage config invalid'); return getEvidenceStore(cfg.config) }
const admin = () => { if (!cfg?.enabled) throw new Error('storage config invalid'); const c = cfg.config; return new S3Client({ endpoint: c.endpoint, region: c.region, forcePathStyle: c.forcePathStyle, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } }) }

before(async () => {
  if (!ENABLED) return
  assert.ok(cfg?.enabled, `storage config: ${JSON.stringify(cfg && !cfg.enabled ? cfg.problems : '')}`)
  setEvidenceStoreForTests(null) // the REAL S3 store
  await admin().send(new PutBucketCorsCommand({ Bucket: cfg.config.bucket, CORSConfiguration: { CORSRules: [{
    AllowedOrigins: [PAGE_ORIGIN], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 600,
  }] } }))
  const router = express.Router()
  router.use(technicianRouter); router.use(technicianFilesRouter)
  api = await startTestServer('/api/ops/technician', router, { configure: (app) => {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', PAGE_ORIGIN)
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-csrf-protection')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      if (req.method === 'OPTIONS') { res.status(204).end(); return }
      next()
    })
  } })
  pageServer = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>engine</title>') })
  await new Promise<void>((r) => pageServer.listen(PAGE_PORT, '127.0.0.1', r))
  bundle = await evidenceBundle()
  browser = await chromium.launch(process.env.ACAOS_CHROMIUM ? { executablePath: process.env.ACAOS_CHROMIUM } : {})
})
after(async () => {
  setFinalizeEnqueuerForTests(null)
  if (ENABLED) { await browser.close(); await api.close(); await new Promise<void>((r) => pageServer.close(() => r())) }
  await disconnect()
})
beforeEach(async () => {
  if (!ENABLED) return
  await resetDb()
  queued = []
  setFinalizeEnqueuerForTests((async (o: { workspaceId: string; fileId: string }) => { queued.push(o); return {} }) as never)
  // The worker, in-process: finalise whatever `complete` has queued.
  workerTimer = setInterval(() => {
    const job = queued.shift()
    if (job) void finalizeEvidenceFile(job).catch(() => {})
  }, 60)
  ctx = await browser.newContext()
  // tsx compiles with keepNames; the helper it injects into serialised page functions must exist in the page.
  await ctx.addInitScript('globalThis.__name = (f) => f')
  blocked = false
  // "Offline" for the API and the storage host only, so the page itself can still be (re)loaded.
  await ctx.route((u) => u.origin !== PAGE_ORIGIN, (route) => (blocked ? route.abort('internetdisconnected') : route.continue()))
  page = await ctx.newPage()
})
afterEach(async () => {
  if (workerTimer) clearInterval(workerTimer)
  if (ENABLED) await ctx.close()
})

// ── fixtures ────────────────────────────────────────────────────────────────

const photo = (w = 1600, h = 1200) => sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
  .jpeg({ quality: 80 }).withExif({ IFD0: { Copyright: 'secret-owner-name' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1' } }).toBuffer()

async function world(email = 'owner@example.test') {
  const { user: owner, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  let n = 0
  const tech = async (assign = true) => {
    const user = await seedUser(`t${++n}-${Math.random().toString(36).slice(2, 6)}@example.test`)
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'member' } })
    const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: `E${n}`, fullName: `Tech ${n}`, role: 'TECH', userId: user.id } })
    if (assign) await prisma.jobTechnicianAssignment.create({ data: { workspaceId: workspace.id, jobId: job.id, crewMemberId: crew.id } })
    return { user, crew }
  }
  return { owner, ws: workspace, job, tech }
}
type World = Awaited<ReturnType<typeof world>>

/** Load the bundle into a fresh page and create an engine for this user and workspace. */
async function boot(p: Page, w: World, userId: string) {
  await p.goto(`${PAGE_ORIGIN}/`)
  await p.evaluate(bundle)
  await p.evaluate(({ base, token, userId, workspaceId }) => {
    const E = (window as unknown as { AcaosEvidence: Record<string, (...a: unknown[]) => unknown> }).AcaosEvidence
    const raw = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers || {})
      if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      headers.set('Authorization', `Bearer ${token}`)
      const res = await fetch(base + path, { ...init, headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`), { status: res.status })
      return data
    }
    const route = E.makeRouteApi(raw)
    const evApi = E.makeEvidenceApi(route, raw)
    const engine = E.createUploader({ scope: { userId, workspaceId }, api: evApi, sessionUserId: () => userId }) as { start(): Promise<void> }
    ;(window as unknown as Record<string, unknown>).__engine = engine
    ;(window as unknown as Record<string, unknown>).__logs = []
    return engine.start()
  }, { base: api.baseUrl, token: signJwt({ userId }), userId, workspaceId: w.ws.id })
}

const enqueue = (p: Page, jobId: string, bytes: Buffer, allowDuplicate = false) => p.evaluate(async ({ b64, jobId, allowDuplicate }) => {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const eng = (window as unknown as { __engine: { enqueue(o: object): Promise<{ ok: boolean; reason?: string; id?: string }> } }).__engine
  return eng.enqueue({ jobId, file: new File([raw], 'IMG_0001.jpg', { type: 'image/jpeg' }), allowDuplicate })
}, { b64: bytes.toString('base64'), jobId, allowDuplicate })

type View = { id: string; state: string; errorCode: string | null; progress: number }
const snapshot = (p: Page) => p.evaluate(() => (window as unknown as { __engine: { getSnapshot(): { items: View[]; paused: string | null } } }).__engine.getSnapshot())
async function until(cond: () => Promise<boolean>, ms = 25_000) {
  const t0 = Date.now()
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for the browser engine'); await new Promise((r) => setTimeout(r, 100)) }
}
const allIn = (p: Page, state: string, n: number) => async () => { const s = (await snapshot(p)).items; return s.length === n && s.every((i) => i.state === state) }
const files = (w: World) => prisma.evidenceFile.findMany({ where: { workspaceId: w.ws.id }, include: { copies: true } })
const objectSize = async (key: string): Promise<number | null> => { try { return Number((await admin().send(new HeadObjectCommand({ Bucket: cfg!.enabled ? cfg.config.bucket : '', Key: key }))).ContentLength) } catch { return null } }
const objectExists = async (key: string) => (await objectSize(key)) !== null
const idbDump = (p: Page) => p.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('acaos-evidence-queue'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise<unknown[]>((res, rej) => { const r = db.transaction('items').objectStore('items').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  db.close()
  return JSON.stringify(rows, (_k, v) => (v instanceof Blob ? `[blob ${v.size}]` : v))
})
const setThrottle = async (p: Page, uploadBps: number) => {
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: uploadBps })
  return cdp
}

// ── tests ───────────────────────────────────────────────────────────────────

it('a photo goes from the phone to AVAILABLE evidence: stripped, one record, nothing sensitive at rest', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  const src = await photo()
  assert.ok(src.includes('secret-owner-name'))
  const puts: string[] = []
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.headers()['content-type'] ?? '') })
  const r = await enqueue(page, w.job.id, src)
  assert.equal(r.ok, true, JSON.stringify(r))
  await until(allIn(page, 'done', 1))

  const rows = await files(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'AVAILABLE')
  assert.equal(rows[0].crewMemberId, t.crew.id)
  assert.equal(rows[0].submissionId, r.id, 'the queue id is the idempotency key')
  assert.deepEqual(puts, ['image/jpeg'])
  const prim = rows[0].copies.find((c: { location: string }) => c.location === 'primary')!
  const stored = (await store().getBytes(prim.objectKey, 25 * 1024 * 1024))!
  const meta = await sharp(stored).metadata()
  assert.equal(meta.exif, undefined, 'the stored object has no EXIF')
  assert.ok(!stored.includes('secret-owner-name'))
  assert.ok(Math.max(meta.width!, meta.height!) <= 2560)

  const at = await idbDump(page)
  for (const s of ['X-Amz', 'Signature', 'Credential', '127.0.0.1:19000', 'Bearer', signJwt({ userId: t.user.id }).slice(0, 20)]) assert.ok(!at.includes(s), `IndexedDB must not contain "${s}"`)
  assert.ok(at.includes('"state":"done"') && at.includes('"blob":null'), 'a finished item keeps no photo')
})

it('photos queued while the connection is down survive a reload and upload exactly once when it returns', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  blocked = true
  for (let i = 0; i < 3; i++) assert.equal((await enqueue(page, w.job.id, await photo())).ok, true)
  await until(async () => { const s = (await snapshot(page)).items; return s.length === 3 && s.every((i) => i.errorCode === 'network') })
  assert.equal((await files(w)).length, 0, 'nothing reaches the server while the connection is down')

  await page.reload()                     // the tab is reloaded (or killed and reopened) before the connection returns
  await boot(page, w, t.user.id)
  assert.equal((await snapshot(page)).items.length, 3, 'the queue survived the reload')
  assert.equal((await page.evaluate(() => (window as unknown as { __engine: { unsent(): Promise<{ count: number }> } }).__engine.unsent())).count, 3)

  blocked = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))      // connectivity recovery resumes at once, skipping backoff
  await until(allIn(page, 'done', 3))
  const rows = await files(w)
  assert.equal(rows.length, 3)
  assert.ok(rows.every((f: { status: string }) => f.status === 'AVAILABLE'))
  assert.equal(new Set(rows.map((f: { submissionId: string }) => f.submissionId)).size, 3)
})

it('a connection that drops mid-upload resumes on its own: one record, nothing partial', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  const cdp = await setThrottle(page, 120_000)
  const started = page.waitForRequest((r) => r.method() === 'PUT')
  assert.equal((await enqueue(page, w.job.id, await photo(2400, 1800))).ok, true)
  await started
  await new Promise((r) => setTimeout(r, 600))
  await ctx.setOffline(true)
  await until(async () => (await snapshot(page)).items.some((i) => i.errorCode === 'network' || i.errorCode === 'timeout'))
  const mid = await files(w)
  assert.equal(mid.length, 1)
  assert.equal(mid[0].status, 'PENDING', 'the interrupted upload never became evidence')
  const up = mid[0].copies.find((c: { location: string }) => c.location === 'upload')!
  const size = await objectSize(up.objectKey)
  assert.ok(size === null || size === up.sizeBytes, `an object that exists is complete (${size} of ${up.sizeBytes} bytes): a dropped upload never leaves a partial one`)
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await ctx.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await until(allIn(page, 'done', 1), 40_000)
  const rows = await files(w)
  assert.equal(rows.length, 1, 'still exactly one record')
  assert.equal(rows[0].status, 'AVAILABLE')
})

it('cancelling an upload in progress stops it, cancels the server record and leaves nothing behind', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  await setThrottle(page, 100_000)
  const started = page.waitForRequest((r) => r.method() === 'PUT')
  const r = await enqueue(page, w.job.id, await photo(2400, 1800))
  await started
  await page.evaluate((id) => (window as unknown as { __engine: { cancel(id: string): Promise<void> } }).__engine.cancel(id), r.id!)
  await until(async () => (await snapshot(page)).items.length === 0)
  await until(async () => { const f = await files(w); return f.length === 1 && f[0].status === 'REJECTED' })
  assert.equal((await files(w)).filter((f: { status: string }) => f.status === 'AVAILABLE').length, 0)
  await sweepAbandonedEvidenceUploads({})
  const f = (await files(w))[0]
  assert.equal(await objectExists(f.copies.find((c: { location: string }) => c.location === 'upload')!.objectKey), false)
  assert.equal(JSON.parse(await idbDump(page)).length, 0)
})

it('many photos at once: at most two uploads in flight, all finish, no duplicates', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  let inflight = 0, peak = 0
  const url = (r: { url(): string; method(): string }) => r.method() === 'PUT' && r.url().includes(':19000')
  page.on('request', (r) => { if (url(r)) { inflight++; peak = Math.max(peak, inflight) } })
  page.on('requestfinished', (r) => { if (url(r)) inflight-- })
  page.on('requestfailed', (r) => { if (url(r)) inflight-- })
  await setThrottle(page, 600_000)
  for (let i = 0; i < 6; i++) assert.equal((await enqueue(page, w.job.id, await photo(1200, 900))).ok, true)
  await until(allIn(page, 'done', 6), 60_000)
  assert.ok(peak <= 2, `peak concurrent uploads was ${peak}`)
  assert.ok(peak >= 1)
  const rows = await files(w)
  assert.equal(rows.length, 6)
  assert.equal(new Set(rows.map((f: { submissionId: string }) => f.submissionId)).size, 6)
})

it('the same photo twice is one upload unless the person confirms', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  await ctx.setOffline(true)
  const src = await photo()
  assert.equal((await enqueue(page, w.job.id, src)).ok, true)
  const dup = await enqueue(page, w.job.id, src)
  assert.deepEqual([dup.ok, dup.reason], [false, 'duplicate'])
  assert.equal((await enqueue(page, w.job.id, src, true)).ok, true)
  await ctx.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await until(allIn(page, 'done', 2))
  assert.equal((await files(w)).length, 2)
})

it('authorization is enforced end to end: a revoked assignment, a closed job and another technician all end as final rejections', async () => {
  const w = await world(); const a = await w.tech(); const stranger = await w.tech(false)
  await boot(page, w, a.user.id)
  await ctx.setOffline(true)
  assert.equal((await enqueue(page, w.job.id, await photo())).ok, true)
  await prisma.jobTechnicianAssignment.deleteMany({ where: { jobId: w.job.id, crewMemberId: a.crew.id } })   // revoked while the phone was offline
  await ctx.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await until(async () => (await snapshot(page)).items.every((i) => i.state === 'rejected' && i.errorCode === 'forbidden'))
  assert.equal((await files(w)).length, 0)
  assert.equal(JSON.parse(await idbDump(page))[0].blob, null, 'a final rejection drops the photo')

  // a technician who was never assigned
  const p2 = await ctx.newPage()
  await boot(p2, w, stranger.user.id)
  assert.equal((await enqueue(p2, w.job.id, await photo())).ok, true)
  await until(async () => (await snapshot(p2)).items.every((i) => i.state === 'rejected' && i.errorCode === 'forbidden'))

  // a closed job
  const b = await w.tech()
  const p3 = await ctx.newPage()
  await boot(p3, w, b.user.id)
  await ctx.setOffline(true)
  await enqueue(p3, w.job.id, await photo())
  await prisma.job.update({ where: { id: w.job.id }, data: { status: 'COMPLETE' } })
  await ctx.setOffline(false)
  await p3.evaluate(() => window.dispatchEvent(new Event('online')))
  await until(async () => (await snapshot(p3)).items.every((i) => i.state === 'rejected' && i.errorCode === 'job_closed'))
  assert.equal((await files(w)).length, 0)
})

it('queues are isolated per account and workspace in the same browser, and sign-out wipes them', async () => {
  const w = await world(); const a = await w.tech(); const b = await w.tech()
  await boot(page, w, a.user.id)
  blocked = true
  assert.equal((await enqueue(page, w.job.id, await photo())).ok, true)

  const p2 = await ctx.newPage()                      // same browser profile, another account signs in
  await boot(p2, w, b.user.id)
  assert.equal((await snapshot(p2)).items.length, 0, "the next account does not see the first account's photos")
  const other = await p2.evaluate(async () => {
    const E = (window as unknown as { AcaosEvidence: { IndexedDbQueueStore: new () => { list(s: object): Promise<unknown[]> } } }).AcaosEvidence
    return (await new E.IndexedDbQueueStore().list({ userId: 'someone', workspaceId: 'ws-x' })).length
  })
  assert.equal(other, 0)

  blocked = false
  await p2.evaluate(() => window.dispatchEvent(new Event('online')))
  await new Promise((r) => setTimeout(r, 800))
  assert.equal((await files(w)).filter((f: { crewMemberId: string }) => f.crewMemberId === b.crew.id).length, 0, "account B never uploads account A's photo")

  // sign-out: warn first, then wipe every account's queue on this browser
  blocked = true
  const unsent = await page.evaluate(() => (window as unknown as { __engine: { unsent(): Promise<{ count: number }> } }).__engine.unsent())
  assert.ok(unsent.count >= 0)
  await page.evaluate(() => (window as unknown as { __engine: { dispose(): void } }).__engine.dispose())
  await page.evaluate(() => (window as unknown as { AcaosEvidence: { purgeAllQueuedPhotos(): Promise<void> } }).AcaosEvidence.purgeAllQueuedPhotos())
  assert.equal(JSON.parse(await idbDump(page)).length, 0)
})

it('browsers: the unsupported-format message reaches the person and nothing is queued', async () => {
  const w = await world(); const t = await w.tech()
  await boot(page, w, t.user.id)
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)])
  const r = await page.evaluate(async (b64) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const eng = (window as unknown as { __engine: { enqueue(o: object): Promise<{ ok: boolean; reason?: string; message?: string }> } }).__engine
    return eng.enqueue({ jobId: 'x', file: new File([raw], 'IMG_1.HEIC', { type: 'image/heic' }) })
  }, heic.toString('base64'))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'heic_unsupported')
  assert.match(r.message ?? '', /HEIC\/HEIF/)
  assert.equal((await snapshot(page)).items.length, 0)
  assert.equal((await files(w)).length, 0)
  void randomUUID
})
