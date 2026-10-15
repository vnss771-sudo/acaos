import { test, expect, type Page, type Route } from '@playwright/test'
import sharp from 'sharp'

// The technician photo screen on the production build, under the exact nginx CSP, on an Android phone
// profile. The backend and the storage host are fakes (page.route), so this tests the real UI + real
// upload engine + real IndexedDB + real image pipeline end to end without any infrastructure.
test.use({ baseURL: 'http://localhost:4173', viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true })

const STORAGE = 'https://storage.example.test'
type Fake = {
  puts: Array<{ bytes: Buffer; type: string; length: string }>
  inits: number
  declaredSize: number[]
  completes: number
  cancels: number
  files: Map<string, string>
  failPutsWith: number | null
  holdPut: Promise<void> | null
  logouts: number
}

function me(id: string) {
  return {
    user: { id, email: `${id}@example.test`, name: id },
    workspaces: [
      { id: 'ws-1', name: 'Acme Plumbing', slug: 'acme', plan: 'STARTER', role: 'member', onboardingCompleted: true },
      { id: 'ws-2', name: 'Beta Electrical', slug: 'beta', plan: 'STARTER', role: 'member', onboardingCompleted: true },
    ],
  }
}

async function install(page: Page, opts: { user?: string; photos?: boolean } = {}) {
  const fake: Fake = { puts: [], inits: 0, declaredSize: [], completes: 0, cancels: 0, files: new Map(), failPutsWith: null, holdPut: null, logouts: 0 }
  const user = opts.user ?? 'tech-a'
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    if (p === '/api/auth/refresh') return json(route, { token: `tok-${user}` })
    if (p === '/api/auth/me') return json(route, me(user))
    if (p === '/api/auth/logout') { fake.logouts++; return json(route, { ok: true }) }
    if (p === '/api/ops/technician/assigned') {
      return json(route, { linked: true, photos: opts.photos !== false, jobs: [{ id: 'job-1', status: 'ACTIVE', siteName: 'Smith St', jobCode: 'J-1', assignedAt: '2026-10-01T00:00:00Z' }] })
    }
    const init = p.match(/^\/api\/ops\/technician\/([^/]+)\/files\/init$/)
    if (init && req.method() === 'POST') {
      fake.inits++
      const body = req.postDataJSON() as { submissionId: string; sizeBytes: number }
      fake.declaredSize.push(body.sizeBytes)
      const sub = body.submissionId
      const id = fake.files.get(sub) ?? `file-${fake.files.size + 1}`
      fake.files.set(sub, id)
      return json(route, { file: { id, status: 'PENDING', kind: 'PHOTO' }, upload: { method: 'PUT', url: `${STORAGE}/up/${id}`, headers: { 'content-type': 'image/jpeg' }, expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    }
    const file = p.match(/^\/api\/ops\/technician\/([^/]+)\/files\/([^/]+?)(\/complete)?$/)
    if (file) {
      if (file[3] && req.method() === 'POST') { fake.completes++; return json(route, { file: { id: file[2], status: 'PENDING', kind: 'PHOTO' }, processing: true }) }
      if (req.method() === 'DELETE') { fake.cancels++; return json(route, { file: { id: file[2], status: 'REJECTED', kind: 'PHOTO' } }) }
      return json(route, { file: { status: 'AVAILABLE' } })
    }
    return json(route, {})
  })
  await page.route(`${STORAGE}/**`, async (route) => {
    const req = route.request()
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'PUT' }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (fake.holdPut) await fake.holdPut
    if (fake.failPutsWith) return route.fulfill({ status: fake.failPutsWith, headers: cors, body: '' })
    fake.puts.push({ bytes: req.postDataBuffer() ?? Buffer.alloc(0), type: req.headers()['content-type'] ?? '', length: req.headers()['content-length'] ?? '' })
    return route.fulfill({ status: 200, headers: cors, body: '' })
  })
  const csp: string[] = []
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()) })
  return { fake, csp }
}

async function photo(opts: { withMeta?: boolean; w?: number; h?: number } = {}) {
  let img = sharp({ create: { width: opts.w ?? 1600, height: opts.h ?? 1200, channels: 3, background: '#2060c0' } }).jpeg()
  if (opts.withMeta) {
    img = img.withExif({
      IFD0: { Copyright: 'secret-owner-name' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' },
    })
  }
  return img.toBuffer()
}

async function openPhotos(page: Page) {
  await page.goto('/ops/technician')
  await page.getByRole('button', { name: /Smith St/ }).click()
  await page.getByRole('tab', { name: /^Photos/ }).click()
}

const file = (buf: Buffer, name = 'p.jpg') => ({ name, mimeType: 'image/jpeg', buffer: buf })

test.describe('technician photos (Android phone, production CSP)', () => {
  test('takes a photo: metadata removed, uploaded with the signed headers, no CSP violations, no horizontal scroll', async ({ page }) => {
    const { fake, csp } = await install(page)
    await openPhotos(page)
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo({ withMeta: true })))
    await expect(page.getByRole('list', { name: 'Photos for this job' }).getByText('Uploaded', { exact: true })).toBeVisible()
    expect(fake.puts).toHaveLength(1)
    const put = fake.puts[0]
    expect(put.type).toBe('image/jpeg')
    expect(fake.declaredSize).toEqual([put.bytes.length])
    expect(put.bytes.includes('secret-owner-name')).toBe(false)
    const meta = await sharp(put.bytes).metadata()
    expect(meta.exif).toBeUndefined()
    expect(fake.inits).toBe(1)
    expect(fake.completes).toBe(1)
    expect(csp).toEqual([])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
  })

  test('controls are touch sized, labelled, and the camera input requests the rear camera', async ({ page }) => {
    await install(page)
    await openPhotos(page)
    for (const name of ['Take photo', 'Choose from gallery']) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(48)
      expect(box!.width).toBeGreaterThanOrEqual(48)
    }
    await expect(page.getByTestId('photo-camera-input')).toHaveAttribute('capture', 'environment')
    await expect(page.getByTestId('photo-gallery-input')).toHaveAttribute('multiple', '')
  })

  test('fits a 320px screen without horizontal scroll while photos are listed', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    const { fake } = await install(page)
    fake.failPutsWith = 500
    await openPhotos(page)
    await page.getByTestId('photo-gallery-input').setInputFiles([file(await photo(), 'a.jpg'), file(await photo({ w: 900, h: 700 }), 'b.jpg')])
    await expect(page.getByRole('list', { name: 'Photos for this job' }).getByRole('listitem')).toHaveCount(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    for (const b of await page.getByRole('list', { name: 'Photos for this job' }).getByRole('button').all()) {
      const box = await b.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(48)
    }
  })

  test('a photo queued offline survives a reload and uploads once when the connection returns, with no duplicate', async ({ page, context }) => {
    const { fake } = await install(page)
    await openPhotos(page)
    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo()))
    await expect(page.getByText('No connection. Photos will upload when you are back online.')).toBeVisible()
    await expect(page.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()
    expect(fake.puts).toHaveLength(0)

    await context.setOffline(false)
    await page.reload()
    await page.getByRole('button', { name: /Smith St/ }).click()
    await page.getByRole('tab', { name: /^Photos/ }).click()
    await expect(page.getByRole('list', { name: 'Photos for this job' }).getByText('Uploaded', { exact: true })).toBeVisible({ timeout: 15_000 })
    expect(fake.puts).toHaveLength(1)
    expect(fake.completes).toBe(1)
    await expect(page.getByRole('list', { name: 'Photos for this job' }).getByRole('listitem')).toHaveCount(1)
  })

  test('a photo the storage service refuses is reported as not uploaded and can be cleared', async ({ page }) => {
    const { fake } = await install(page)
    fake.failPutsWith = 400
    await openPhotos(page)
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo()))
    const list = page.getByRole('list', { name: 'Photos for this job' })
    await expect(list.getByText(/This photo was not uploaded/)).toBeVisible({ timeout: 15_000 })
    expect(fake.completes).toBe(0)
    await list.getByRole('button', { name: /^Clear Photo/ }).click()
    await expect(list.getByRole('listitem')).toHaveCount(0)
  })

  test('cancelling while the upload is in flight does not leave an uploaded record behind', async ({ page }) => {
    const { fake } = await install(page)
    let release!: () => void
    fake.holdPut = new Promise<void>((r) => { release = r })
    await openPhotos(page)
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo()))
    const list = page.getByRole('list', { name: 'Photos for this job' })
    await list.getByRole('button', { name: /^Cancel Photo/ }).click()
    await page.getByRole('button', { name: 'Keep it' }).click()
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await list.getByRole('button', { name: /^Cancel Photo/ }).click()
    await page.getByRole('button', { name: 'Remove photo' }).click()
    release()
    await expect(list.getByRole('listitem')).toHaveCount(0, { timeout: 15_000 })
    await page.waitForTimeout(500)
    expect(fake.completes).toBe(0)
  })

  test('signing out with unsent photos warns first; staying keeps them, confirming deletes them from this phone', async ({ page }) => {
    const { fake } = await install(page)
    fake.failPutsWith = 500
    await openPhotos(page)
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo()))
    await expect(page.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByText('Sign out', { exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Photos have not finished uploading' })).toBeVisible()
    await page.getByRole('button', { name: 'Stay signed in' }).click()
    expect(fake.logouts).toBe(0)
    await expect(page.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()

    // The drawer is still open after "Stay signed in".
    await page.getByText('Sign out', { exact: true }).click()
    await page.getByRole('button', { name: 'Sign out and delete photos' }).click()
    await expect.poll(() => fake.logouts).toBe(1)
    const left = await page.evaluate(() => new Promise<number>((res) => {
      const r = indexedDB.databases ? indexedDB.databases() : Promise.resolve([])
      void r.then(async (dbs) => {
        let n = 0
        for (const d of dbs) {
          if (!d.name) continue
          const db = await new Promise<IDBDatabase>((ok, bad) => { const q = indexedDB.open(d.name!); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error) })
          for (const store of Array.from(db.objectStoreNames)) {
            n += await new Promise<number>((ok) => { const c = db.transaction(store).objectStore(store).count(); c.onsuccess = () => ok(c.result) })
          }
          db.close()
        }
        res(n)
      })
    }))
    expect(left).toBe(0)
  })

  test('switching workspace with waiting photos warns, and the photos are not deleted', async ({ page }) => {
    const { fake } = await install(page)
    fake.failPutsWith = 500
    await openPhotos(page)
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo()))
    await expect(page.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.locator('select').first().selectOption('ws-2')
    await expect(page.getByRole('dialog', { name: 'Photos are still waiting' })).toBeVisible()
    await page.getByRole('button', { name: 'Stay here' }).click()
    await expect(page.getByRole('dialog', { name: 'Photos are still waiting' })).toHaveCount(0)
  })

  test('another account on the same phone cannot see or open the first account\'s photos, and is told only a count', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, baseURL: 'http://localhost:4173' })
    const page = await ctx.newPage()
    const a = await install(page, { user: 'tech-a' })
    a.fake.failPutsWith = 500
    await openPhotos(page)
    await page.getByTestId('photo-camera-input').setInputFiles(file(await photo()))
    await expect(page.getByText(/saved on this phone and not yet uploaded/)).toBeVisible()

    await page.unroute('**/api/**')
    await page.unroute(`${STORAGE}/**`)
    await install(page, { user: 'tech-b' })
    await openPhotos(page)
    await expect(page.getByText(/from a different account/)).toBeVisible()
    await expect(page.getByText(/can't be opened, uploaded or deleted from this account/)).toBeVisible()
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Photos for this job' })).toHaveCount(0)
    await expect(page.getByText('No photos waiting.')).toBeVisible()
    await ctx.close()
  })

  test('the Photos tab is absent when the server has uploads switched off', async ({ page }) => {
    await install(page, { photos: false })
    await page.goto('/ops/technician')
    await page.getByRole('button', { name: /Smith St/ }).click()
    await expect(page.getByRole('tab', { name: 'Note' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Photos/ })).toHaveCount(0)
  })
})
