import { test, expect, type Page, type Route } from '@playwright/test'
import sharp from 'sharp'

// The manager photo gallery on a delivery Job card, in the production build under the strict CSP, on a
// phone and a desktop viewport. API and storage are faked with page.route; the images are real JPEGs the
// browser really decodes, which is what proves the CSP lets signed storage links render.
test.use({ baseURL: 'http://localhost:4173' })

const STORAGE = 'https://storage.example.test'
type Fake = { listStatus: number; expireFirst: Set<string>; served: Map<string, number>; listCalls: string[] }

async function jpeg(color: string, w = 640, h = 480) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer()
}

async function install(page: Page, opts: { photos?: boolean } = {}) {
  const fake: Fake = { listStatus: 200, expireFirst: new Set(), served: new Map(), listCalls: [] }
  const thumb = await jpeg('#2060c0', 160, 120)
  const full = await jpeg('#c06020')
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const files = [3, 2, 1].map((i) => ({
    id: `f${i}`, status: 'AVAILABLE', kind: 'PHOTO', contentType: 'image/jpeg', sizeBytes: 90_000 + i, width: 640, height: 480, evidenceId: null,
    createdAt: `2026-10-01T09:0${i}:00.000Z`, finalizedAt: `2026-10-01T09:0${i}:30.000Z`, hasThumb: true, uploadedBy: { crewMemberId: 'c1', name: 'Sam Tech' },
  }))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p === '/api/auth/refresh') return json(route, { token: 'tok-owner' })
    if (p === '/api/auth/me') {
      return json(route, { user: { id: 'owner-1', email: 'o@example.test', name: 'Owner' }, workspaces: [{ id: 'ws-1', name: 'Acme', slug: 'acme', plan: 'STARTER', role: 'owner', onboardingCompleted: true }] })
    }
    if (p === '/api/delivery/jobs') {
      const job = (id: string, code: string, status: string) => ({ id, status, closeoutVersion: 0, invoicedRevenueCents: null, otherCostCents: null, site: { id: 's1', jobCode: code, siteName: 'Smith St' }, quote: null, origin: null, economics: null, economicsFrozen: false })
      return json(route, { jobs: [job('job-1', 'S-1', 'ACTIVE'), job('job-2', 'S-1', 'COMPLETE')], ...(opts.photos === false ? {} : { evidencePhotos: true }) })
    }
    if (p === '/api/delivery/report') return json(route, { report: { minJobs: 3, overall: { key: 'ALL', label: 'All', jobs: 0, hoursVariancePct: null, revenueVsQuotePct: null, labourMarginPct: null, grossMarginPct: null }, groups: [] } })
    const list = p.match(/^\/api\/ops\/technician\/([^/]+)\/files$/)
    if (list) { fake.listCalls.push(`${list[1]}?${url.searchParams.get('workspaceId')}`); return fake.listStatus === 200 ? json(route, { files: list[1] === 'job-1' ? files : [], nextCursor: null }) : json(route, { error: 'no' }, fake.listStatus) }
    const content = p.match(/^\/api\/ops\/technician\/([^/]+)\/files\/([^/]+)\/content$/)
    if (content) {
      const variant = url.searchParams.get('variant') ?? 'full'
      return json(route, { url: `${STORAGE}/${variant}/${content[2]}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), variant })
    }
    return json(route, {})
  })
  await page.route(`${STORAGE}/**`, async (route) => {
    const u = new URL(route.request().url())
    const key = u.pathname
    const n = (fake.served.get(key) ?? 0) + 1
    fake.served.set(key, n)
    const cors = { 'access-control-allow-origin': '*' }
    // An expired link: the first fetch of this object is refused, as storage does after the 60 s lapse.
    if (fake.expireFirst.has(key) && n === 1) return route.fulfill({ status: 403, headers: cors, body: '' })
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/jpeg' }, body: key.startsWith('/thumb/') ? thumb : full })
  })
  const csp: string[] = []
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()) })
  return { fake, csp }
}

const decoded = (page: Page, sel: string) => page.evaluate((s) => Array.from(document.querySelectorAll<HTMLImageElement>(s)).filter((i) => i.complete && i.naturalWidth > 0).length, sel)

for (const vp of [{ name: 'phone', width: 412, height: 915 }, { name: 'desktop', width: 1280, height: 800 }]) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.name === 'phone', isMobile: vp.name === 'phone' })

    test('thumbnails render from signed storage links under the strict CSP, and the viewer shows the full photo', async ({ page }) => {
      const { fake, csp } = await install(page)
      await page.goto('/ops/delivery')
      await page.getByRole('button', { name: 'Photos' }).first().click()
      const list = page.getByRole('list', { name: /Photo thumbnails for S-1/ })
      await expect(list.getByRole('button')).toHaveCount(3)
      await expect.poll(() => decoded(page, 'ul[aria-label^="Photo thumbnails"] img')).toBe(3)
      expect(fake.listCalls).toEqual(['job-1?ws-1'])
      await list.getByRole('button').first().click()
      const dlg = page.getByRole('dialog', { name: 'Photo 1 of 3' })
      await expect(dlg).toContainText('Uploaded by Sam Tech')
      await expect.poll(() => decoded(page, '[role=dialog] img')).toBe(1)
      await dlg.getByRole('button', { name: 'Next' }).click()
      await expect(page.getByRole('dialog', { name: 'Photo 2 of 3' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(csp).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    })

    test('an expired thumbnail link is replaced once and still renders', async ({ page }) => {
      const { fake, csp } = await install(page)
      fake.expireFirst.add('/thumb/f2')
      await page.goto('/ops/delivery')
      await page.getByRole('button', { name: 'Photos' }).first().click()
      await expect.poll(() => decoded(page, 'ul[aria-label^="Photo thumbnails"] img')).toBe(3)
      expect(fake.served.get('/thumb/f2')).toBe(2)
      expect(csp.filter((c) => !/Failed to load resource/.test(c))).toEqual([])
    })

    test('losing access removes the photos from the page', async ({ page }) => {
      const { fake } = await install(page)
      await page.goto('/ops/delivery')
      await page.getByRole('button', { name: 'Photos' }).first().click()
      await expect.poll(() => decoded(page, 'ul[aria-label^="Photo thumbnails"] img')).toBe(3)
      fake.listStatus = 403
      await page.getByRole('button', { name: 'Hide photos' }).click()
      // A second gallery (the other Job on the same site) is a separate request and sees the revocation.
      await page.getByRole('button', { name: 'Photos' }).nth(1).click()
      await expect(page.getByRole('alert')).toContainText('You no longer have access to this job')
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    })
  })
}

test('no gallery is offered when the server has photo evidence off', async ({ page }) => {
  await install(page, { photos: false })
  await page.goto('/ops/delivery')
  await expect(page.getByText('S-1 · Smith St').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Photos' })).toHaveCount(0)
})
