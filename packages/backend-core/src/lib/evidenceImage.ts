// Validation and sanitisation of uploaded evidence images. The declared MIME type
// is never trusted: the bytes are sniffed, decoded with a hard pixel limit, and
// RE-ENCODED to a fresh JPEG. Re-encoding is what removes EXIF (including GPS),
// XMP/IPTC, embedded thumbnails, ICC oddities and any payload appended after the
// image data. Only the worker imports this module.
import { createHash } from 'node:crypto'
import { ALLOWED_EVIDENCE_TYPES, type EvidenceImageType } from './evidenceTypes.js'

export { ALLOWED_EVIDENCE_TYPES, type EvidenceImageType }

// sharp is a native module. It is loaded on first use, not at import time, so a
// problem with its binary on some platform can only ever fail evidence
// finalisation (which then retries and rejects) and can never stop the worker from
// starting and serving its other queues.
type SharpModule = (typeof import('sharp'))['default']
let sharpLoad: Promise<SharpModule> | null = null
function loadSharp(): Promise<SharpModule> {
  sharpLoad ??= import('sharp').then((m) => {
    const sharp = m.default
    // Bound native memory/CPU use: no decoded-pixel cache, one libvips thread.
    sharp.cache(false)
    sharp.concurrency(1)
    return sharp
  })
  // Do not cache a failed load: the next attempt may succeed.
  sharpLoad.catch(() => { sharpLoad = null })
  return sharpLoad
}

export const OUTPUT_CONTENT_TYPE = 'image/jpeg' as const

/** The type implied by the file's leading bytes, or null if it is not a supported image. */
export function sniffImageType(b: Buffer): EvidenceImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const SHARP_FORMAT: Record<EvidenceImageType, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }

export type SanitizeRejection = 'empty' | 'unsupported_type' | 'type_mismatch' | 'too_many_pixels' | 'decode_failed'
export type SanitizeResult =
  | { ok: true; bytes: Buffer; contentType: typeof OUTPUT_CONTENT_TYPE; width: number; height: number; sha256: string }
  | { ok: false; reason: SanitizeRejection }

export async function sanitizeEvidenceImage(
  input: Buffer,
  opts: { declaredType: string; maxPixels: number; maxEdge?: number; quality?: number },
): Promise<SanitizeResult> {
  if (input.length === 0) return { ok: false, reason: 'empty' }
  const sniffed = sniffImageType(input)
  if (!sniffed) return { ok: false, reason: 'unsupported_type' }
  if (sniffed !== opts.declaredType) return { ok: false, reason: 'type_mismatch' }
  const maxEdge = opts.maxEdge ?? 2048
  const sharp = await loadSharp() // a load failure propagates (transient), it is not a bad image
  try {
    const probe = await sharp(input, { limitInputPixels: opts.maxPixels, failOn: 'error' }).metadata()
    if (probe.format !== SHARP_FORMAT[sniffed]) return { ok: false, reason: 'type_mismatch' }
    if (!probe.width || !probe.height) return { ok: false, reason: 'decode_failed' }
    const { data, info } = await sharp(input, { limitInputPixels: opts.maxPixels, failOn: 'error' })
      .rotate() // apply EXIF orientation, then the metadata is dropped below
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // no alpha channel in the output
      .jpeg({ quality: opts.quality ?? 82 }) // no keepMetadata(): all metadata is discarded
      .toBuffer({ resolveWithObject: true })
    return {
      ok: true, bytes: data, contentType: OUTPUT_CONTENT_TYPE,
      width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex'),
    }
  } catch (e) {
    return { ok: false, reason: /pixel limit/i.test((e as Error).message) ? 'too_many_pixels' : 'decode_failed' }
  }
}

export type ThumbnailResult = { bytes: Buffer; width: number; height: number; sha256: string }

/**
 * A small JPEG for gallery grids, made from bytes that already went through
 * sanitizeEvidenceImage (so the input is a metadata-free JPEG we produced).
 * Throws on failure; the caller decides whether a missing thumbnail matters.
 */
export async function makeEvidenceThumbnail(
  sanitizedJpeg: Buffer,
  opts: { maxEdge?: number; quality?: number; maxPixels: number },
): Promise<ThumbnailResult> {
  const sharp = await loadSharp()
  const { data, info } = await sharp(sanitizedJpeg, { limitInputPixels: opts.maxPixels, failOn: 'error' })
    .resize({ width: opts.maxEdge ?? 320, height: opts.maxEdge ?? 320, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: opts.quality ?? 72 })
    .toBuffer({ resolveWithObject: true })
  return { bytes: data, width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex') }
}
