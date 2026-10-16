import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { createApiAccount, PASSWORD } from './helpers.js'

// The complete technician-to-manager photo workflow, locally, with nothing mocked:
//   production web build behind the production CSP -> real API -> real PostgreSQL -> real BullMQ worker ->
//   throwaway S3-compatible storage (real presigned PUT/GET, real CORS), in real Chromium.
// Started by scripts/e2e-evidence-local.sh (npm run e2e:evidence-local). Never runs against a provider account.

// Needs the local stack from scripts/e2e-evidence-local.sh (which sets E2E_S3_ENDPOINT); skipped in the default Playwright run and in CI.
test.skip(!process.env.E2E_S3_ENDPOINT, 'local full-stack only: npm run e2e:evidence-local')

const prisma = new PrismaClient()
const S3_ENDPOINT = process.env.E2E_S3_ENDPOINT ?? 'http://127.0.0.1:8333'
const BUCKET = process.env.E2E_S3_BUCKET ?? 'acaos-e2e-evidence'
const s3 = new S3Client({
  endpoint: S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.EVIDENCE_S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.EVIDENCE_S3_SECRET_ACCESS_KEY ?? '' },
})
const STORAGE = new URL(S3_ENDPOINT).origin

test.afterAll(async () => { await prisma.$disconnect() })

// ── fixtures ────────────────────────────────────────────────────────────────

type Tech = { email: string; userId: string; crewId: string }
type World = { ownerEmail: string; ownerId: string; ws: string; jobId: string; otherJobId: string; newTech: (assign?: boolean) => Promise<Tech> }

async function makeWorld(request: APIRequestContext): Promise<World> {
  const owner = await createApiAccount(request)
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { onboardingCompleted: true } })   // skip the setup wizard
  const site = await prisma.opsJobSite.create({ data: { workspaceId: owner.workspaceId, jobCode: `W${Date.now() % 100000}`, siteName: 'Smith St' } })
  const job = await prisma.job.create({ data: { workspaceId: owner.workspaceId, opsJobSiteId: site.id } })
  const other = await prisma.job.create({ data: { workspaceId: owner.workspaceId, opsJobSiteId: site.id } })
  let n = 0
  const newTech = async (assign = true): Promise<Tech> => {
    const t = await createApiAccount(request)
    // The technician belongs to the manager's workspace only (their own throwaway one is removed).
    await prisma.membership.deleteMany({ where: { userId: t.userId } })
    await prisma.membership.create({ data: { workspaceId: owner.workspaceId, userId: t.userId, role: 'member' } })
    const crew = await prisma.opsCrewMember.create({ data: { workspaceId: owner.workspaceId, employeeCode: `T${++n}-${randomUUID().slice(0, 6)}`, fullName: `Tech ${n}`, role: 'TECH', userId: t.userId, isActive: true } })
    if (assign) await prisma.jobTechnicianAssignment.create({ data: { workspaceId: owner.workspaceId, jobId: job.id, crewMemberId: crew.id } })
    return { email: t.email, userId: t.userId, crewId: crew.id }
  }
  return { ownerEmail: owner.email, ownerId: owner.userId, ws: owner.workspaceId, jobId: job.id, otherJobId: other.id, newTech }
}

async function signIn(context: BrowserContext, email: string) {
  await context.clearCookies()
  const res = await context.request.post('/api/auth/login', { data: { email, password: PASSWORD } })
  expect(res.ok(), `login ${res.status()}`).toBeTruthy()
}

async function photoBytes(seed: number, opts: { w?: number; h?: number; meta?: boolean } = {}) {
  const img = sharp({ create: { width: opts.w ?? 1600, height: opts.h ?? 1200, channels: 3, noise: { type: 'gaussian', mean: 100 + seed * 17 % 120, sigma: 50 } } }).jpeg({ quality: 80 })
  return (opts.meta === false ? img : img.withExif({ IFD0: { Copyright: 'secret-owner-name' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' } })).toBuffer()
}

const csp: string[] = []
function watch(page: Page) {
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()) })
}

async function openTechPhotos(page: Page) {
  await page.goto('/ops/technician')
  await page.getByRole('button', { name: /Smith St/ }).click()
  await page.getByRole('tab', { name: /^Photos/ }).click()
}
const addPhoto = async (page: Page, bytes: Buffer, name = 'IMG.jpg') =>
  page.getByTestId('photo-camera-input').setInputFiles({ name, mimeType: 'image/jpeg', buffer: bytes })
const techList = (page: Page) => page.getByRole('list', { name: 'Photos for this job' })

/** The manager's gallery for THIS Job (a site's other Job has its own card and its own gallery). */
const galleryToggle = (mp: Page, w: World) => mp.locator(`button[aria-controls="job-photos-${w.jobId}"]`)
const galleryGrid = (mp: Page, w: World) => mp.locator(`#job-photos-${w.jobId}`).getByRole('list', { name: /Photo thumbnails for/ })

const files = (w: World, status?: string) => prisma.evidenceFile.findMany({ where: { workspaceId: w.ws, jobId: w.jobId, ...(status ? { status } : {}) }, include: { copies: true }, orderBy: { createdAt: 'asc' } })
async function objects(w: World, kind: 'final' | 'thumb' | 'upload') {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `ws/${w.ws}/job/${w.jobId}/${kind}/` }))
  return out.Contents ?? []
}
async function objectBytes(key: string) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  return Buffer.from(await r.Body!.transformToByteArray())
}

/**
 * Cut the phone off from the API's photo routes and from storage (weak signal: the rest of the API still answers).
 * With `everything`, the whole API is unreachable too (airplane mode); the page itself stays loadable.
 */
async function goOffline(context: BrowserContext, everything = false) {
  const handler = (route: { abort: (c: string) => Promise<void> }) => route.abort('internetdisconnected')
  const api = everything ? '**/api/**' : '**/api/ops/technician/*/files/**'
  await context.route(api, handler as never)
  await context.route(`${STORAGE}/**`, handler as never)
  return async () => { await context.unroute(api, handler as never); await context.unroute(`${STORAGE}/**`, handler as never) }
}

const mobile = { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true } as const

test.beforeEach(() => { csp.length = 0 })
test.afterEach(() => { expect(csp, 'no CSP violations in the whole run').toEqual([]) })

// ── 1. the whole workflow ───────────────────────────────────────────────────

test('technician photos reach the manager gallery: sanitised, thumbnailed, attributed, one record each', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()

  const phone = await browser.newContext(mobile)
  await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)
  await openTechPhotos(tp)
  await addPhoto(tp, await photoBytes(1), 'a.jpg')
  await addPhoto(tp, await photoBytes(2, { w: 4000, h: 3000 }), 'b.jpg')
  await expect(techList(tp).getByText('Uploaded', { exact: true })).toHaveCount(2, { timeout: 60_000 })

  // Server state: exactly two AVAILABLE evidence records with verified primary and thumbnail, nothing pending.
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length).toBe(2)
  const rows = await files(w)
  expect(rows).toHaveLength(2)
  for (const f of rows) {
    expect(f.status).toBe('AVAILABLE')
    expect(f.crewMemberId).toBe(tech.crewId)
    const locations = f.copies.filter((c) => c.status === 'VERIFIED').map((c) => c.location).sort()
    expect(locations).toEqual(expect.arrayContaining(['primary', 'thumb']))
  }
  expect(await objects(w, 'final')).toHaveLength(2)
  expect(await objects(w, 'thumb')).toHaveLength(2)

  // What is stored is metadata-free and bounded.
  for (const o of await objects(w, 'final')) {
    const bytes = await objectBytes(o.Key!)
    const meta = await sharp(bytes).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.exif).toBeUndefined()
    expect(bytes.includes('secret-owner-name')).toBe(false)
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2560)
  }

  // The manager, on a desktop, sees both on the Job's card.
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await signIn(desk, w.ownerEmail)
  const mp = await desk.newPage(); watch(mp)
  await mp.goto('/ops/delivery')
  await galleryToggle(mp, w).click()
  const grid = galleryGrid(mp, w)
  await expect(grid.getByRole('button')).toHaveCount(2)
  await expect.poll(() => mp.evaluate(() => Array.from(document.querySelectorAll<HTMLImageElement>('ul[aria-label^="Photo thumbnails"] img')).filter((i) => i.complete && i.naturalWidth > 0).length)).toBe(2)
  await grid.getByRole('button').first().click()
  const dlg = mp.getByRole('dialog', { name: /Photo 1 of 2/ })
  await expect(dlg).toContainText(`Uploaded by Tech 1`)
  await expect.poll(() => mp.evaluate(() => { const i = document.querySelector<HTMLImageElement>('[role=dialog] img'); return !!i && i.complete && i.naturalWidth > 0 })).toBe(true)
  await phone.close(); await desk.close()
})

test('the manager sees photos uploaded after the gallery was first opened (refresh)', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)
  await openTechPhotos(tp)
  await addPhoto(tp, await photoBytes(3))
  await expect(techList(tp).getByText('Uploaded', { exact: true })).toHaveCount(1, { timeout: 60_000 })

  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await signIn(desk, w.ownerEmail)
  const mp = await desk.newPage(); watch(mp)
  await mp.goto('/ops/delivery')
  await galleryToggle(mp, w).click()
  await expect(galleryGrid(mp, w).getByRole('button')).toHaveCount(1)

  await addPhoto(tp, await photoBytes(4))
  await expect(techList(tp).getByText('Uploaded', { exact: true })).toHaveCount(2, { timeout: 60_000 })
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length).toBe(2)

  // Closing and reopening the gallery, or pressing Refresh, shows the new photo without reloading the page.
  await galleryToggle(mp, w).click()
  await galleryToggle(mp, w).click()
  await expect(galleryGrid(mp, w).getByRole('button')).toHaveCount(2)
  await phone.close(); await desk.close()
})

// ── 2. connectivity ─────────────────────────────────────────────────────────

test('offline: a photo is kept across a reload and uploads exactly once when the connection returns', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)
  await openTechPhotos(tp)
  const back = await goOffline(phone)
  await tp.evaluate(() => window.dispatchEvent(new Event('offline')))
  await addPhoto(tp, await photoBytes(5))
  await expect(tp.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()
  expect(await files(w)).toHaveLength(0)

  await tp.reload()                                    // the app is closed and reopened while still offline
  await tp.getByRole('button', { name: /Smith St/ }).click()
  await tp.getByRole('tab', { name: /^Photos/ }).click()
  await expect(techList(tp).getByRole('listitem')).toHaveCount(1)
  expect(await files(w)).toHaveLength(0)

  await back()
  await tp.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(techList(tp).getByText('Uploaded', { exact: true })).toHaveCount(1, { timeout: 60_000 })
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length).toBe(1)
  await tp.reload()
  await tp.getByRole('button', { name: /Smith St/ }).click()
  await tp.getByRole('tab', { name: /^Photos/ }).click()
  await tp.waitForTimeout(1500)
  expect(await files(w)).toHaveLength(1)              // a reload does not upload it again
  expect(await objects(w, 'final')).toHaveLength(1)
  await phone.close()
})

test('airplane mode: the app is closed and reopened with no connection at all; nothing is lost and the photo uploads on its own once back online', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)
  await openTechPhotos(tp)
  const back = await goOffline(phone, true)
  await addPhoto(tp, await photoBytes(11))
  await expect(tp.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()
  await tp.reload()                                   // reopened offline: the session cannot even be refreshed
  await tp.waitForTimeout(1000)
  // F1: the phone still says photos are waiting: the count when the session survived the reopen, otherwise only the generic sign-in line.
  await expect(tp.getByTestId('photos-waiting-banner').or(tp.getByTestId('photos-signed-out-notice'))).toBeVisible()
  expect(await tp.getByTestId('photos-signed-out-notice').textContent().catch(() => '')).not.toMatch(/\d/)
  expect(await files(w)).toHaveLength(0)
  await back()
  // Back online the app starts, sees the saved photo and uploads it without anyone opening the Photos tab.
  await tp.reload()
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length, { timeout: 60_000 }).toBe(1)
  expect(await files(w)).toHaveLength(1)
  expect((await files(w))[0].crewMemberId).toBe(tech.crewId)
  await phone.close()
})

test('F1: weak signal reopen shows the count; signed out shows only the generic line; the count returns after sign-in; another account sees neither count', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const a = await w.newTech(); const b = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, a.email)
  const page = await phone.newPage(); watch(page)
  await openTechPhotos(page)
  const back = await goOffline(phone)
  await addPhoto(page, await photoBytes(21))
  await expect(techList(page).locator('li')).toHaveCount(1)
  await addPhoto(page, await photoBytes(22))
  await expect(techList(page).locator('li')).toHaveCount(2)
  await page.reload()                                  // reopened on a weak signal: the job list loads but photos cannot be sent
  const banner = page.getByTestId('photos-waiting-banner')
  await expect(banner).toContainText('2 photos saved on this phone are waiting to upload.')
  await expect(banner).toContainText(/Waiting (for a connection|to upload)/)
  expect(await banner.locator('button, a').count()).toBe(0)

  // The session ends: the sign-in screen gives a generic line, with no count and no account hint.
  await phone.clearCookies()
  await page.goto('/')
  const generic = page.getByTestId('photos-signed-out-notice')
  await expect(generic).toHaveText('Photos saved on this phone are waiting to upload. Sign in with the account that took them.')
  expect(await page.content()).not.toContain(a.email)

  // Another account on the shared phone sees the foreign notice (existing) but not A's count.
  await signIn(phone, b.email)
  await page.goto('/ops/technician')
  await expect(page.getByTestId('photos-waiting-banner')).toHaveCount(0)
  await expect(page.getByTestId('photos-signed-out-notice')).toHaveCount(0)

  // A signs back in: the count is back and, once online, everything uploads and the banner clears.
  await signIn(phone, a.email)
  await page.goto('/ops/technician')
  await expect(page.getByTestId('photos-waiting-banner')).toContainText('2 photos')
  await back()
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length, { timeout: 60_000 }).toBe(2)
  await expect(page.getByTestId('photos-waiting-banner')).toHaveCount(0, { timeout: 30_000 })
  await phone.close()
})

test('interrupted uploads: a dropped storage connection and a lost "complete" answer still end with one record', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)

  let putsDropped = 0
  await phone.route(`${STORAGE}/**`, (route) => {
    if (route.request().method() === 'PUT' && putsDropped < 2) { putsDropped++; return route.abort('connectionreset') }
    return route.continue()
  })
  let completeSeen = 0
  await phone.route('**/api/ops/technician/*/files/*/complete', async (route) => {
    completeSeen++
    if (completeSeen === 1) { await route.fetch(); return route.abort('connectionreset') }   // the server did the work; the phone never heard
    return route.continue()
  })
  await openTechPhotos(tp)
  await addPhoto(tp, await photoBytes(6))
  await expect(techList(tp).getByText('Uploaded', { exact: true })).toHaveCount(1, { timeout: 90_000 })
  expect(putsDropped).toBe(2)
  expect(completeSeen).toBeGreaterThanOrEqual(1)      // the first answer was lost; the phone then learns the outcome (status or a repeat that is idempotent)
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length).toBe(1)
  expect(await files(w)).toHaveLength(1)
  expect(await objects(w, 'final')).toHaveLength(1)
  expect(await objects(w, 'thumb')).toHaveLength(1)
  await phone.close()
})

// ── 3. accounts and authorisation ───────────────────────────────────────────

test('shared phone: another account never sees, uploads or deletes the first account\'s queued photo', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const a = await w.newTech(); const b = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, a.email)
  const page = await phone.newPage(); watch(page)
  await openTechPhotos(page)
  const back = await goOffline(phone)
  await addPhoto(page, await photoBytes(7))
  await expect(page.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()

  // A's session ends without signing out (expiry); B signs in on the same phone and browser profile.
  await signIn(phone, b.email)
  await page.goto('/ops/technician')
  await expect(page.getByText(/from a different account/)).toBeVisible()
  await expect(page.getByText(/can't be opened, uploaded or deleted from this account/)).toBeVisible()
  await expect(page.getByTestId('photos-waiting-banner')).toHaveCount(0)   // F1: B's banner never counts A's photo
  await back()
  await page.getByRole('button', { name: /Smith St/ }).click()
  await page.getByRole('tab', { name: /^Photos/ }).click()
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0)
  await expect(techList(page)).toHaveCount(0)
  await page.waitForTimeout(2500)
  expect(await files(w)).toHaveLength(0)             // nothing was uploaded under B

  // B adds their own photo: it belongs to B.
  await addPhoto(page, await photoBytes(8))
  await expect(techList(page).getByText('Uploaded', { exact: true })).toHaveCount(1, { timeout: 60_000 })
  // A signs back in: the original photo is still there and uploads under A.
  await signIn(phone, a.email)
  await page.goto('/ops/technician')
  await page.getByRole('button', { name: /Smith St/ }).click()
  await page.getByRole('tab', { name: /^Photos/ }).click()
  await expect(techList(page).getByText('Uploaded', { exact: true })).toHaveCount(1, { timeout: 60_000 })
  await expect.poll(async () => (await files(w, 'AVAILABLE')).length).toBe(2)
  const owners = (await files(w)).map((f) => f.crewMemberId).sort()
  expect(owners).toEqual([a.crewId, b.crewId].sort())
  await phone.close()
})

test('assignment revoked while a photo waits: it is refused, nothing is stored, and the phone says so', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)
  await openTechPhotos(tp)
  const back = await goOffline(phone)
  await addPhoto(tp, await photoBytes(9))
  await expect(tp.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()
  await prisma.jobTechnicianAssignment.deleteMany({ where: { jobId: w.jobId, crewMemberId: tech.crewId } })
  await back()
  await tp.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(techList(tp).getByText(/not uploaded|not saved|rejected|no longer/i)).toBeVisible({ timeout: 60_000 })
  await tp.waitForTimeout(1500)
  expect(await files(w)).toHaveLength(0)
  expect(await objects(w, 'final')).toHaveLength(0)
  expect(await objects(w, 'upload')).toHaveLength(0)
  await phone.close()
})

test('manager access revoked while the gallery is open: the next request clears every photo', async ({ browser, request }) => {
  const w = await makeWorld(request)
  const tech = await w.newTech()
  const phone = await browser.newContext(mobile); await signIn(phone, tech.email)
  const tp = await phone.newPage(); watch(tp)
  await openTechPhotos(tp)
  await addPhoto(tp, await photoBytes(10))
  await expect(techList(tp).getByText('Uploaded', { exact: true })).toHaveCount(1, { timeout: 60_000 })

  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await signIn(desk, w.ownerEmail)
  const mp = await desk.newPage(); watch(mp)
  await mp.goto('/ops/delivery')
  await galleryToggle(mp, w).click()
  const grid = galleryGrid(mp, w)
  await expect(grid.getByRole('button')).toHaveCount(1)
  await expect.poll(() => mp.evaluate(() => document.querySelectorAll('ul[aria-label^="Photo thumbnails"] img').length)).toBe(1)

  // The owner is demoted (done in the database here); the role cache lasts at most 5 s.
  await prisma.membership.update({ where: { userId_workspaceId: { userId: w.ownerId, workspaceId: w.ws } }, data: { role: 'member' } })
  await mp.waitForTimeout(6500)
  await grid.getByRole('button').first().click()       // opening the viewer asks for a fresh signed link
  await expect(mp.getByRole('alert')).toContainText('You no longer have access to this job')
  await mp.keyboard.press('Escape')
  expect(await mp.evaluate(() => document.querySelectorAll('img').length)).toBe(0)
  await phone.close(); await desk.close()
})
