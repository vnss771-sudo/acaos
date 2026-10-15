// Turn a photo picked from the camera or gallery into the exact bytes that will be uploaded: a
// JPEG, oriented upright, scaled down, with no metadata. This runs on the device before anything
// touches the network, so a failure here never creates a server record.
//
// Why re-encode on the device when the server re-encodes anyway: it normalises orientation, keeps
// GPS and camera details off the wire (the server stays authoritative), and typically shrinks a
// 6 to 15 MB camera file to 0.5 to 2.5 MB, which matters on a weak mobile connection. The upload
// is signed for an exact byte length and type, so the bytes produced here are final: they are
// stored in the queue as-is and never re-encoded on a retry.
import { EVIDENCE_LIMITS, type EvidenceLimits } from './limits'
import { sniffFormat, readDimensions, readJpegOrientation, stripJpegMetadata, jpegHasMetadata, type ImageFormat } from './imageFormat'

export type ImageErrorCode =
  | 'empty' | 'too_large_input' | 'unsupported_format' | 'heic_unsupported'
  | 'too_many_pixels' | 'decode_failed' | 'too_large_output' | 'encode_failed'

const MESSAGES: Record<ImageErrorCode, string> = {
  empty: 'That file is empty.',
  too_large_input: 'That photo is too large to process. Choose a smaller one.',
  unsupported_format: 'Only JPEG, PNG and WebP photos are supported.',
  heic_unsupported: 'This phone could not convert that HEIC/HEIF photo. Take the photo again with the camera, or change the camera format to "Most Compatible" (JPEG) and try again.',
  too_many_pixels: 'That photo has too many pixels to process on this device.',
  decode_failed: 'That photo could not be read. Try another one.',
  too_large_output: 'That photo is still too large after compression. Try another one.',
  encode_failed: 'That photo could not be prepared. Try again.',
}

export class ImageError extends Error {
  readonly code: ImageErrorCode
  constructor(code: ImageErrorCode) {
    super(MESSAGES[code])
    this.name = 'ImageError'
    this.code = code
  }
}

export type PreparedImage = {
  blob: Blob
  contentType: 'image/jpeg'
  sizeBytes: number
  width: number
  height: number
  sha256: string
  /** A tiny `data:` image for lists (CSP allows data:, not blob:), or null if it could not be made. */
  preview?: string | null
}

/** What the browser has to provide. The real implementation is in imageCodec.ts; tests use a fake. */
export interface ImageCodec {
  /**
   * Decode `source`, apply its EXIF orientation, and scale so the long edge is at most `maxEdge`
   * (never enlarge). `expected` is the upright size predicted from the header, when known, so an
   * implementation can decode directly at the target size without holding a full-size bitmap.
   */
  decode(source: Blob, o: { maxEdge: number; expected: { width: number; height: number } | null }): Promise<DecodedImage>
}
export interface DecodedImage {
  width: number
  height: number
  /** Encode as JPEG (white background, no metadata). */
  toJpeg(quality: number): Promise<Blob>
  /** A small JPEG (long edge `maxEdge`) for list previews. Optional: without it there is no preview. */
  toPreview?(maxEdge: number, quality: number): Promise<Blob>
  release(): void
}

export type PrepareOptions = { limits?: EvidenceLimits; codec: ImageCodec; digest?: (b: ArrayBuffer) => Promise<string> }

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('')
async function defaultDigest(b: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new ImageError('encode_failed')
  return toHex(await subtle.digest('SHA-256', b))
}

// Blob.arrayBuffer() exists in every supported browser; FileReader covers older WebViews and jsdom.
const readBytes = (b: Blob): Promise<Uint8Array> => {
  if (typeof b.arrayBuffer === 'function') return b.arrayBuffer().then((ab) => new Uint8Array(ab))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => reject(r.error)
    r.readAsArrayBuffer(b)
  })
}

/** Upright size predicted from the header and EXIF orientation (5 to 8 swap width and height). */
function predictUpright(head: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
  const d = readDimensions(head, format)
  if (!d || d.width <= 0 || d.height <= 0) return null
  const swap = format === 'jpeg' && readJpegOrientation(head) >= 5
  return swap ? { width: d.height, height: d.width } : d
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** Best effort: a missing preview must never fail a photo. */
async function makePreview(d: DecodedImage, edge: number): Promise<string | null> {
  if (!d.toPreview) return null
  try {
    const url = await blobToDataUrl(await d.toPreview(edge, 0.6))
    return url.startsWith('data:image/jpeg') && url.length < 60_000 ? url : null
  } catch {
    return null
  }
}

export async function prepareImage(file: Blob, opts: PrepareOptions): Promise<PreparedImage> {
  const limits = opts.limits ?? EVIDENCE_LIMITS
  if (file.size === 0) throw new ImageError('empty')
  if (file.size > limits.maxInputBytes) throw new ImageError('too_large_input')

  // The real type comes from the bytes. The file name and the browser-declared MIME type are ignored.
  const head = await readBytes(file.slice(0, 65536))
  const format = sniffFormat(head)
  if (format === 'unknown' || format === 'gif') throw new ImageError('unsupported_format')
  const heicLike = format === 'heic' || format === 'avif'

  const claimed = heicLike ? null : readDimensions(head, format)
  if (claimed && claimed.width * claimed.height > limits.maxSourcePixels) throw new ImageError('too_many_pixels')
  const expected = heicLike ? null : predictUpright(head, format)

  let lastTooBig = false
  for (const edge of limits.edgeLadder) {
    let decoded: DecodedImage
    try {
      decoded = await opts.codec.decode(file, { maxEdge: edge, expected })
    } catch (e) {
      if (e instanceof ImageError) throw e
      // Browsers that cannot decode HEIC/HEIF report a generic decode error; say what it really is.
      throw new ImageError(heicLike ? 'heic_unsupported' : 'decode_failed')
    }
    try {
      for (const q of limits.qualityLadder) {
        let jpeg: Blob
        try { jpeg = await decoded.toJpeg(q) } catch { throw new ImageError('encode_failed') }
        if (jpeg.size === 0) throw new ImageError('encode_failed')
        if (jpeg.size > limits.maxUploadBytes) { lastTooBig = true; continue }
        // Belt and braces: whatever the encoder wrote, no metadata segment leaves this function.
        let bytes: Uint8Array = await readBytes(jpeg)
        if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw new ImageError('encode_failed')
        if (jpegHasMetadata(bytes)) {
          const clean = stripJpegMetadata(bytes)
          if (!clean || jpegHasMetadata(clean)) throw new ImageError('encode_failed')
          bytes = clean
        }
        const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' })
        if (blob.size > limits.maxUploadBytes) { lastTooBig = true; continue }
        const digest = opts.digest ?? defaultDigest
        const preview = await makePreview(decoded, limits.previewEdge)
        return {
          blob, contentType: 'image/jpeg', sizeBytes: blob.size,
          width: decoded.width, height: decoded.height,
          sha256: await digest(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
          preview,
        }
      }
    } finally {
      decoded.release()
    }
  }
  throw new ImageError(lastTooBig ? 'too_large_output' : 'encode_failed')
}
