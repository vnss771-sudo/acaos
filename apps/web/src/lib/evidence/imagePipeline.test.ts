import { describe, it, expect } from 'vitest'
import { sniffFormat, readDimensions, readJpegOrientation, stripJpegMetadata, jpegHasMetadata } from './imageFormat'
import { prepareImage, ImageError, type ImageCodec, type DecodedImage } from './imagePipeline'
import { EVIDENCE_LIMITS } from './limits'
import { buildJpeg, buildPng, buildWebpVp8x, buildHeic, buildGif, asBlob, exifPayload } from './fixtures'

const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b)
const readBlob = (b: Blob) => new Promise<Uint8Array>((res) => { const r = new FileReader(); r.onload = () => res(new Uint8Array(r.result as ArrayBuffer)); r.readAsArrayBuffer(b) })

describe('sniffFormat', () => {
  it('identifies formats from bytes, not names', () => {
    expect(sniffFormat(buildJpeg())).toBe('jpeg')
    expect(sniffFormat(buildPng(10, 10))).toBe('png')
    expect(sniffFormat(buildWebpVp8x(10, 10))).toBe('webp')
    expect(sniffFormat(buildGif())).toBe('gif')
    expect(sniffFormat(buildHeic('heic'))).toBe('heic')
    expect(sniffFormat(buildHeic('mif1'))).toBe('heic')
    expect(sniffFormat(buildHeic('avif'))).toBe('avif')
    expect(sniffFormat(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('unknown')
    expect(sniffFormat(new TextEncoder().encode('%PDF-1.7'))).toBe('unknown')
    expect(sniffFormat(new Uint8Array([]))).toBe('unknown')
  })
})

describe('readDimensions / orientation', () => {
  it('reads claimed dimensions without decoding', () => {
    expect(readDimensions(buildJpeg({ width: 4032, height: 3024 }))).toEqual({ width: 4032, height: 3024 })
    expect(readDimensions(buildPng(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(readDimensions(buildWebpVp8x(800, 600))).toEqual({ width: 800, height: 600 })
    expect(readDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
  })
  it('reads the EXIF orientation of a JPEG', () => {
    expect(readJpegOrientation(buildJpeg({ exif: true, orientation: 6 }))).toBe(6)
    expect(readJpegOrientation(buildJpeg({ exif: true, orientation: 1 }))).toBe(1)
    expect(readJpegOrientation(buildJpeg())).toBe(1)
  })
})

describe('stripJpegMetadata', () => {
  it('removes EXIF/GPS, XMP, ICC, comments and non-JFIF APP0, keeps the image data byte for byte', () => {
    const src = buildJpeg({ exif: true, xmp: true, icc: true, comment: 'secret-comment', jfxx: true, scan: 100 })
    expect(jpegHasMetadata(src)).toBe(true)
    expect(text(src)).toContain('GPS-LAT')
    const out = stripJpegMetadata(src)!
    expect(jpegHasMetadata(out)).toBe(false)
    const s = text(out)
    for (const secret of ['GPS-LAT', 'Exif', 'secret-xmp', 'ICC_PROFILE', 'secret-comment', 'JFXX']) expect(s).not.toContain(secret)
    expect(s).toContain('JFIF')
    expect(readDimensions(out)).toEqual({ width: 640, height: 480 })
    // the scan data and EOI are untouched
    expect(Array.from(out.slice(-34))).toEqual(Array.from(src.slice(-34)))
    expect(out.length).toBeLessThan(src.length)
  })
  it('is a no-op on a clean file and refuses things that are not JPEGs', () => {
    const clean = buildJpeg()
    expect(Array.from(stripJpegMetadata(clean)!)).toEqual(Array.from(clean))
    expect(stripJpegMetadata(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull()
    expect(stripJpegMetadata(buildPng(2, 2))).toBeNull()
    const truncated = buildJpeg({ exif: true }).slice(0, 40)
    expect(stripJpegMetadata(truncated)).toBeNull()
  })
})

// A fake codec: records what it was asked for and returns JPEGs of a chosen size per quality.
function fakeCodec(opts: { sizes?: (edge: number, q: number) => number; withExif?: boolean; fail?: 'decode'; dims?: [number, number] } = {}) {
  const calls: Array<{ edge: number; expected: unknown }> = []
  const released: number[] = []
  const codec: ImageCodec = {
    async decode(_src, { maxEdge, expected }): Promise<DecodedImage> {
      calls.push({ edge: maxEdge, expected })
      if (opts.fail === 'decode') throw new Error('boom')
      const [w, h] = opts.dims ?? [Math.min(maxEdge, 2560), Math.round(Math.min(maxEdge, 2560) * 0.75)]
      return {
        width: w, height: h,
        async toJpeg(q) {
          const size = opts.sizes ? opts.sizes(maxEdge, q) : 1000
          const overhead = buildJpeg({ width: w, height: h, exif: opts.withExif, scan: 0 }).length
          return asBlob(buildJpeg({ width: w, height: h, exif: opts.withExif, scan: Math.max(0, size - overhead) }))
        },
        release() { released.push(maxEdge) },
      }
    },
  }
  return { codec, calls, released }
}
const digest = async () => 'a'.repeat(64)

describe('prepareImage', () => {
  it('produces a metadata-free JPEG with the sha256 of the final bytes', async () => {
    const { codec, released } = fakeCodec({ withExif: true })
    const r = await prepareImage(asBlob(buildJpeg({ exif: true, width: 4000, height: 3000 })), { codec })
    const bytes = await readBlob(r.blob)
    expect(r.contentType).toBe('image/jpeg')
    expect(r.blob.type).toBe('image/jpeg')
    expect(r.sizeBytes).toBe(bytes.length)
    expect(jpegHasMetadata(bytes)).toBe(false)
    expect(text(bytes)).not.toContain('GPS-LAT')
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(released.length).toBeGreaterThan(0)
  })
  it('asks for the upright size predicted from the header and EXIF orientation', async () => {
    const { codec, calls } = fakeCodec()
    await prepareImage(asBlob(buildJpeg({ exif: true, orientation: 6, width: 4000, height: 3000 })), { codec, digest })
    expect(calls[0]).toEqual({ edge: 2560, expected: { width: 3000, height: 4000 } })
  })
  it('walks down the quality then edge ladder until the file fits', async () => {
    const max = EVIDENCE_LIMITS.maxUploadBytes
    const { codec, calls } = fakeCodec({ sizes: (edge, q) => (edge === 2560 ? max + 1 : q >= 0.75 ? max + 1 : 500_000) })
    const r = await prepareImage(asBlob(buildJpeg()), { codec, digest })
    expect(r.sizeBytes).toBeLessThanOrEqual(max)
    expect(calls.map((c) => c.edge)).toEqual([2560, 2048])
  })
  it('fails with too_large_output when nothing fits, and releases every bitmap', async () => {
    const { codec, released } = fakeCodec({ sizes: () => EVIDENCE_LIMITS.maxUploadBytes + 5 })
    await expect(prepareImage(asBlob(buildJpeg()), { codec, digest })).rejects.toMatchObject({ code: 'too_large_output' })
    expect(released).toEqual([...EVIDENCE_LIMITS.edgeLadder])
  })
  it('enforces the input caps before decoding', async () => {
    const { codec, calls } = fakeCodec()
    await expect(prepareImage(new Blob([]), { codec })).rejects.toMatchObject({ code: 'empty' })
    await expect(prepareImage(asBlob(buildJpeg()), { codec, limits: { ...EVIDENCE_LIMITS, maxInputBytes: 10 } })).rejects.toMatchObject({ code: 'too_large_input' })
    await expect(prepareImage(asBlob(buildJpeg({ width: 20000, height: 20000 })), { codec })).rejects.toMatchObject({ code: 'too_many_pixels' })
    expect(calls).toHaveLength(0)
  })
  it('rejects non-photos by their bytes, whatever the declared type or name says', async () => {
    const { codec, calls } = fakeCodec()
    for (const bad of [buildGif(), new TextEncoder().encode('<svg onload=alert(1)>'), new TextEncoder().encode('%PDF-1.7 ....'), new Uint8Array(100)]) {
      await expect(prepareImage(asBlob(bad, 'image/jpeg'), { codec })).rejects.toMatchObject({ code: 'unsupported_format' })
    }
    expect(calls).toHaveLength(0)
  })
  it('accepts PNG and WebP', async () => {
    const { codec } = fakeCodec()
    expect((await prepareImage(asBlob(buildPng(800, 600), 'image/png'), { codec, digest })).contentType).toBe('image/jpeg')
    expect((await prepareImage(asBlob(buildWebpVp8x(800, 600), 'image/webp'), { codec, digest })).contentType).toBe('image/jpeg')
  })
  it('says clearly when HEIC/HEIF cannot be converted on this device, and converts when the browser can', async () => {
    const dead = fakeCodec({ fail: 'decode' })
    const e = await prepareImage(asBlob(buildHeic('heic'), 'image/heic'), { codec: dead.codec }).catch((x) => x)
    expect(e).toBeInstanceOf(ImageError)
    expect(e.code).toBe('heic_unsupported')
    expect(e.message).toMatch(/HEIC\/HEIF/)
    expect(e.message).toMatch(/Most Compatible|camera/)
    await expect(prepareImage(asBlob(buildHeic('avif')), { codec: dead.codec })).rejects.toMatchObject({ code: 'heic_unsupported' })
    // a JPEG that fails to decode is a generic decode failure, not a HEIC message
    await expect(prepareImage(asBlob(buildJpeg()), { codec: dead.codec })).rejects.toMatchObject({ code: 'decode_failed' })
    // a browser that can decode HEIC (Safari) just works: no header dimensions are assumed
    const ok = fakeCodec()
    const r = await prepareImage(asBlob(buildHeic('heic')), { codec: ok.codec, digest })
    expect(r.contentType).toBe('image/jpeg')
    expect(ok.calls[0].expected).toBeNull()
  })
  it('strips metadata an encoder left behind, and refuses output that is not a JPEG', async () => {
    const leaky = fakeCodec({ withExif: true })
    const r = await prepareImage(asBlob(buildJpeg()), { codec: leaky.codec, digest })
    expect(text(await readBlob(r.blob))).not.toContain('GPS-LAT')
    const broken: ImageCodec = { async decode() { return { width: 1, height: 1, toJpeg: async () => new Blob([new Uint8Array([1, 2, 3])]), release() {} } } }
    await expect(prepareImage(asBlob(buildJpeg()), { codec: broken, digest })).rejects.toMatchObject({ code: 'encode_failed' })
  })
  it('exposes a readable orientation helper for the fixture', () => {
    expect(exifPayload(6).length).toBeGreaterThan(20)
  })
})
