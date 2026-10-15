// Byte-level image helpers: what a file really is, how big it claims to be, and (for JPEG)
// removal of every metadata segment. Pure functions over Uint8Array; no DOM needed.

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'heic' | 'avif' | 'unknown'

const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len))

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'])

/** The real type, from the leading bytes. The declared MIME type and the file name are never trusted. */
export function sniffFormat(b: Uint8Array): ImageFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8') return 'gif'
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (HEIC_BRANDS.has(brand)) return 'heic'
    if (brand === 'avif' || brand === 'avis') return 'avif'
  }
  return 'unknown'
}

export type Dimensions = { width: number; height: number }

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)

/** Dimensions claimed by the header (no decoding). Null when they cannot be read. */
export function readDimensions(b: Uint8Array, format: ImageFormat = sniffFormat(b)): Dimensions | null {
  try {
    if (format === 'png') return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null
    if (format === 'jpeg') {
      let o = 2
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue }
        const m = b[o + 1]
        if (m === 0xff) { o++; continue }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(b, o + 5), width: u16be(b, o + 7) }
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue }
        o += 2 + u16be(b, o + 2)
      }
      return null
    }
    if (format === 'webp') {
      const kind = ascii(b, 12, 4)
      if (kind === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
      if (kind === 'VP8 ') return { width: ((b[27] << 8) | b[26]) & 0x3fff, height: ((b[29] << 8) | b[28]) & 0x3fff }
      if (kind === 'VP8L') {
        const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
        return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
      }
    }
  } catch { /* fall through */ }
  return null
}

/** EXIF orientation (1 to 8) of a JPEG, or 1 when absent. Only used to predict the displayed size. */
export function readJpegOrientation(b: Uint8Array): number {
  let o = 2
  while (o + 4 < b.length) {
    if (b[o] !== 0xff) return 1
    const m = b[o + 1]
    if (m === 0xda || m === 0xd9) return 1
    const len = u16be(b, o + 2)
    if (m === 0xe1 && ascii(b, o + 4, 4) === 'Exif') {
      const t = o + 10 // start of the TIFF header
      const le = ascii(b, t, 2) === 'II'
      const r16 = (p: number) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1])
      const r32 = (p: number) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : u32be(b, p))
      const ifd = t + r32(t + 4)
      const n = r16(ifd)
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12
        if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1 }
      }
      return 1
    }
    o += 2 + len
  }
  return 1
}

/**
 * Rebuild a JPEG without any metadata segments: every APPn except the JFIF APP0 (EXIF, XMP, ICC,
 * Photoshop/IPTC, GPS) and every comment is dropped. Image data is copied byte for byte. Returns
 * null when the bytes are not a well-formed JPEG header, so the caller can refuse the file.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (!(b.length > 4 && b[0] === 0xff && b[1] === 0xd8)) return null
  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)]
  let o = 2
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) return null
    const m = b[o + 1]
    if (m === 0xff) { o++; continue }
    if (m === 0xd9) { out.push(Uint8Array.of(0xff, 0xd9)); o += 2; break }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(Uint8Array.of(0xff, m)); o += 2; continue }
    if (o + 3 >= b.length) return null
    const len = u16be(b, o + 2)
    if (len < 2 || o + 2 + len > b.length) return null
    const seg = b.subarray(o, o + 2 + len)
    const isApp = m >= 0xe0 && m <= 0xef
    const isJfif = m === 0xe0 && ascii(b, o + 4, 4) === 'JFIF'
    const drop = (isApp && !isJfif) || m === 0xfe // EXIF/XMP/ICC/IPTC/GPS (APP1+), non-JFIF APP0, comments
    if (!drop) out.push(seg)
    o += 2 + len
    if (m === 0xda) {
      // entropy-coded image data up to the end of the file is copied untouched
      out.push(b.subarray(o))
      o = b.length
      break
    }
  }
  const flat = new Uint8Array(out.reduce((n, a) => n + a.length, 0))
  let p = 0
  for (const a of out) { flat.set(a, p); p += a.length }
  return flat
}

/** True when a JPEG still carries any metadata segment (used as an assertion on our own output). */
export function jpegHasMetadata(b: Uint8Array): boolean {
  let o = 2
  while (o + 3 < b.length) {
    if (b[o] !== 0xff) return false
    const m = b[o + 1]
    if (m === 0xda || m === 0xd9) return false
    if (m === 0xff) { o++; continue }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue }
    if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) return true
    if (m === 0xe0 && ascii(b, o + 4, 4) !== 'JFIF') return true
    o += 2 + u16be(b, o + 2)
  }
  return false
}
