import { test, expect, type Page } from '@playwright/test'
import sharp from 'sharp'
import { evidenceBundle } from './evidenceBundle.js'

// The client-side evidence modules running unmodified in real Chromium, on the production build
// served under the exact nginx CSP. Covers what a unit test cannot: the real IndexedDB queue (data
// survives a reload, scopes are isolated, caps hold under concurrency), and the real image pipeline
// (createImageBitmap + canvas): orientation, EXIF/GPS removal, downscaling, unsupported formats.
// No network is used. The bundle is evaluated through the DevTools protocol, which the page CSP
// does not apply to, so the page still enforces the real policy for everything it does itself.
test.use({ baseURL: 'http://localhost:4173' })

type Evidence = {
  IndexedDbQueueStore: new () => unknown
  runQueueStoreContract: (make: () => Promise<unknown>) => Promise<void>
  contractItem: (scope: { userId: string; workspaceId: string }, id: string, over?: object) => { id: string }
  prepareImage: (f: Blob, o: { codec: unknown }) => Promise<{ blob: Blob; width: number; height: number; sizeBytes: number; sha256: string }>
  ImageError: new (c: string) => Error
  browserImageCodec: unknown
  jpegHasMetadata: (b: Uint8Array) => boolean
}
declare global { interface Window { AcaosEvidence: Evidence } }

async function load(page: Page) {
  const csp = (await page.goto('/'))?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("script-src 'self'")
  await page.evaluate(await evidenceBundle())
  await page.evaluate(() => { if (!window.AcaosEvidence) throw new Error('bundle not loaded') })
}

const b64 = (b: Buffer) => b.toString('base64')
const LIMITS = { maxQueueItems: 5, maxQueueBytes: 10_000_000 }

test.describe('IndexedDB queue (real browser)', () => {
  test('satisfies the queue store contract, including scope isolation and atomic caps', async ({ page }) => {
    await load(page)
    await page.evaluate(async () => {
      const { IndexedDbQueueStore, runQueueStoreContract } = window.AcaosEvidence
      await runQueueStoreContract(async () => new IndexedDbQueueStore())
    })
  })

  test('photos survive a reload byte for byte, and another browser profile cannot see them', async ({ page, browser }) => {
    await load(page)
    await page.evaluate(async (limits) => {
      const { IndexedDbQueueStore, contractItem } = window.AcaosEvidence
      const s = new IndexedDbQueueStore() as { clearAll(): Promise<void>; add(sc: object, i: object, o: object): Promise<{ ok: boolean }> }
      await s.clearAll()
      const scope = { userId: 'u1', workspaceId: 'w1' }
      const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 255)
      const it = contractItem(scope, 'photo-1', { blob: new Blob([bytes], { type: 'image/jpeg' }), sizeBytes: 4096 })
      if (!(await s.add(scope, it, { limits })).ok) throw new Error('add failed')
    }, LIMITS)

    await page.reload()
    await page.evaluate(await evidenceBundle())
    const survived = await page.evaluate(async () => {
      const { IndexedDbQueueStore } = window.AcaosEvidence
      const s = new IndexedDbQueueStore() as { list(sc: object): Promise<Array<{ id: string; blob: Blob | null; state: string }>> }
      const items = await s.list({ userId: 'u1', workspaceId: 'w1' })
      const other = await s.list({ userId: 'u2', workspaceId: 'w1' })
      const buf = new Uint8Array(await items[0].blob!.arrayBuffer())
      return { ids: items.map((i) => i.id), type: items[0].blob!.type, size: buf.length, sum: buf.reduce((a, c) => a + c, 0), others: other.length }
    })
    expect(survived.ids).toEqual(['photo-1'])
    expect(survived.type).toBe('image/jpeg')
    expect(survived.size).toBe(4096)
    expect(survived.sum).toBe(Array.from({ length: 4096 }, (_, i) => (i * 7) & 255).reduce((a, c) => a + c, 0))
    expect(survived.others).toBe(0)

    const fresh = await browser.newContext()
    const page2 = await fresh.newPage()
    await load(page2)
    const seen = await page2.evaluate(async () => {
      const { IndexedDbQueueStore } = window.AcaosEvidence
      return (await (new IndexedDbQueueStore() as { list(sc: object): Promise<unknown[]> }).list({ userId: 'u1', workspaceId: 'w1' })).length
    })
    expect(seen).toBe(0)
    await fresh.close()

    await page.evaluate(async () => { await (new window.AcaosEvidence.IndexedDbQueueStore() as { clearAll(): Promise<void> }).clearAll() })
  })
})

test.describe('image pipeline (real Chromium decoder, canvas and createImageBitmap)', () => {
  const run = (page: Page, bytes: Buffer, type: string) => page.evaluate(async ({ data, type }) => {
    const { prepareImage, browserImageCodec, jpegHasMetadata } = window.AcaosEvidence
    const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const t0 = performance.now()
    try {
      const r = await prepareImage(new File([raw], 'IMG_0001.jpg', { type }), { codec: browserImageCodec })
      const out = new Uint8Array(await r.blob.arrayBuffer())
      const bmp = await createImageBitmap(r.blob)
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
      const ctx = c.getContext('2d')!; ctx.drawImage(bmp, 0, 0)
      const px = (x: number, y: number) => Array.from(ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3))
      return {
        ok: true as const, ms: Math.round(performance.now() - t0), width: r.width, height: r.height, decodedW: bmp.width, decodedH: bmp.height,
        size: r.sizeBytes, type: r.blob.type, metadata: jpegHasMetadata(out), sha: r.sha256,
        hasGpsText: new TextDecoder('latin1').decode(out).includes('secret-owner') || new TextDecoder('latin1').decode(out).includes('Exif'),
        top: px(bmp.width / 2, bmp.height / 4), bottom: px(bmp.width / 2, (bmp.height * 3) / 4), corner: px(2, 2),
      }
    } catch (e) {
      return { ok: false as const, code: (e as { code?: string }).code, message: (e as Error).message }
    }
  }, { data: b64(bytes), type })

  // Left half red, right half blue.
  const twoTone = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#0000ff' } })
    .composite([{ input: { create: { width: w / 2, height: h, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])

  test('applies EXIF orientation, strips EXIF and GPS, and downsizes a large photo', async ({ page }) => {
    await load(page)
    const src = await twoTone(4000, 3000).jpeg({ quality: 90 }).withExif({
      IFD0: { Copyright: 'secret-owner-name' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' },
    }).withMetadata({ orientation: 6 }).toBuffer()
    expect((await sharp(src).metadata()).orientation).toBe(6)
    expect(src.includes('secret-owner-name')).toBe(true)
    const r = await run(page, src, 'image/jpeg')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.type).toBe('image/jpeg')
    expect(r.metadata).toBe(false)
    expect(r.hasGpsText).toBe(false)
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2560)
    // orientation 6 turns the landscape file upright (portrait), left half (red) on top
    expect(r.decodedH).toBeGreaterThan(r.decodedW)
    expect(r.top[0]).toBeGreaterThan(200); expect(r.top[2]).toBeLessThan(60)
    expect(r.bottom[2]).toBeGreaterThan(200); expect(r.bottom[0]).toBeLessThan(60)
    expect(r.size).toBeLessThan(src.length)
    expect(r.sha).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a 48-megapixel photo is processed within the limits', async ({ page }) => {
    await load(page)
    const src = await twoTone(8000, 6000).jpeg({ quality: 85 }).toBuffer()
    const r = await run(page, src, 'image/jpeg')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2560)
    expect(r.size).toBeLessThanOrEqual(10 * 1024 * 1024)
    console.log(`48 MP photo processed in ${r.ms} ms, ${(src.length / 1e6).toFixed(1)} MB -> ${(r.size / 1e6).toFixed(2)} MB`)
  })

  test('PNG and WebP become JPEG with a white background (no transparency)', async ({ page }) => {
    await load(page)
    const png = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const rp = await run(page, png, 'image/png')
    expect(rp.ok && rp.type).toBe('image/jpeg')
    if (rp.ok) { expect(rp.corner.every((v) => v > 240)).toBe(true) }
    const webp = await twoTone(800, 600).webp().toBuffer()
    const rw = await run(page, webp, 'image/webp')
    expect(rw.ok && rw.type).toBe('image/jpeg')
  })

  test('refuses unsupported and disguised files with clear codes, including HEIC this browser cannot decode', async ({ page }) => {
    await load(page)
    const gif = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex')
    const pdfAsJpg = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n')
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    for (const [bytes, type] of [[gif, 'image/gif'], [pdfAsJpg, 'image/jpeg'], [svg, 'image/svg+xml']] as const) {
      const r = await run(page, bytes, type)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('unsupported_format')
    }
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)])
    const rh = await run(page, heic, 'image/heic')
    expect(rh.ok).toBe(false)
    if (!rh.ok) { expect(rh.code).toBe('heic_unsupported'); expect(rh.message).toMatch(/HEIC\/HEIF/) }
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
    const rc = await run(page, corrupt, 'image/jpeg')
    expect(rc.ok).toBe(false)
    if (!rc.ok) expect(rc.code).toBe('decode_failed')
  })
})
