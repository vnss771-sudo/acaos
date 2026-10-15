// The browser implementation of ImageCodec: createImageBitmap (with the EXIF orientation applied
// by the decoder) drawn onto a canvas. A canvas never carries metadata, so re-encoding through it
// drops EXIF, GPS, XMP and ICC; imagePipeline additionally verifies and strips on the output.
//
// Memory on a low-end phone is the main risk. When the header tells us the upright size we ask the
// decoder for the target size directly so a 48 MP photo is never held as a full-size bitmap; if the
// browser ignores that or returns an unexpected size, we fall back to a full decode and a canvas
// downscale. Anything that throws is reported by the caller as a decode failure.
import type { ImageCodec, DecodedImage } from './imagePipeline'
import { ImageError } from './imagePipeline'

type Canvasish = HTMLCanvasElement | OffscreenCanvas

function scaledSize(w: number, h: number, maxEdge: number) {
  const s = Math.min(1, maxEdge / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

function makeCanvas(w: number, h: number): Canvasish {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

async function canvasToBlob(c: Canvasish, quality: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type: 'image/jpeg', quality })
  return new Promise((resolve, reject) => (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality))
}

async function bitmapFrom(source: Blob, target: { width: number; height: number } | null): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is not available')
  if (target) {
    try {
      return await createImageBitmap(source, { imageOrientation: 'from-image', resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' })
    } catch { /* fall through to the plain decode */ }
  }
  return createImageBitmap(source, { imageOrientation: 'from-image' })
}

export const browserImageCodec: ImageCodec = {
  async decode(source, { maxEdge, expected }): Promise<DecodedImage> {
    const want = expected ? scaledSize(expected.width, expected.height, maxEdge) : null
    let bmp = await bitmapFrom(source, want)
    // A browser that applied the resize before the orientation (or ignored it) gives the wrong
    // shape; detect it and decode again without resizing rather than ship a distorted photo.
    if (expected && want) {
      const ratioWant = want.width / want.height
      const ratioGot = bmp.width / bmp.height
      if (Math.abs(ratioGot - ratioWant) / ratioWant > 0.02) { bmp.close(); bmp = await bitmapFrom(source, null) }
    }
    const { width, height } = scaledSize(bmp.width, bmp.height, maxEdge)
    const canvas = makeCanvas(width, height)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) { bmp.close(); throw new ImageError('decode_failed') }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bmp, 0, 0, width, height)
    bmp.close()
    return {
      width, height,
      toJpeg: (q) => canvasToBlob(canvas, q),
      async toPreview(maxEdge, quality) {
        const small = scaledSize(width, height, maxEdge)
        const c = makeCanvas(small.width, small.height)
        const cx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
        if (!cx) throw new Error('no 2d context')
        cx.drawImage(canvas as CanvasImageSource, 0, 0, small.width, small.height)
        return canvasToBlob(c, quality)
      },
      release() { canvas.width = 0; canvas.height = 0 },
    }
  },
}
