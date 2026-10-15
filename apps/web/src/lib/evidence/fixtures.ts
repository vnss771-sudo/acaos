// Test fixtures: tiny hand-built image files. Not imported by application code.

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const bytes = (...parts: Array<number | number[] | Uint8Array>) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : Array.from(p))))
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))
const seg = (marker: number, payload: number[]) => [0xff, marker, ...be16(payload.length + 2), ...payload]

/** A TIFF/EXIF block with an orientation tag and some GPS-looking text that must never survive. */
export function exifPayload(orientation = 1, secret = 'GPS-LAT-33.8688S'): number[] {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // big-endian header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation, SHORT, 1 value
    0, 0, 0, 0, // next IFD
    ...ascii(secret),
  ]
  return [...ascii('Exif'), 0, 0, ...tiff]
}

export type JpegOpts = { width?: number; height?: number; orientation?: number; exif?: boolean; comment?: string; xmp?: boolean; icc?: boolean; jfxx?: boolean; scan?: number }

/** Marker-correct JPEG skeleton (headers + a dummy entropy-coded scan). Not decodable, which is fine for byte-level tests. */
export function buildJpeg(o: JpegOpts = {}): Uint8Array {
  const { width = 640, height = 480 } = o
  return bytes(
    [0xff, 0xd8],
    seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    o.jfxx ? seg(0xe0, [...ascii('JFXX'), 0, 0x10, 1, 2, 3]) : [],
    o.exif ? seg(0xe1, exifPayload(o.orientation ?? 1)) : [],
    o.xmp ? seg(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta>secret-xmp</x:xmpmeta>')]) : [],
    o.icc ? seg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, 9, 9, 9]) : [],
    o.comment ? seg(0xfe, ascii(o.comment)) : [],
    seg(0xdb, [0, ...new Array(64).fill(8)]),
    seg(0xc0, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]),
    seg(0xda, [1, 1, 0, 0, 63, 0]),
    new Array(o.scan ?? 32).fill(0x55),
    [0xff, 0xd9],
  )
}

export function buildPng(width: number, height: number): Uint8Array {
  const ihdr = [0, 0, 0, 13, ...ascii('IHDR'), 0, 0, (width >> 8) & 0xff, width & 0xff, 0, 0, (height >> 8) & 0xff, height & 0xff, 8, 2, 0, 0, 0, 0, 0, 0, 0]
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ihdr, new Array(20).fill(1))
}

export function buildWebpVp8x(width: number, height: number): Uint8Array {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
  return bytes(ascii('RIFF'), [0x20, 0, 0, 0], ascii('WEBP'), ascii('VP8X'), [10, 0, 0, 0], [0, 0, 0, 0], le24(width - 1), le24(height - 1), new Array(8).fill(0))
}

export function buildHeic(brand = 'heic'): Uint8Array {
  return bytes([0, 0, 0, 24], ascii('ftyp'), ascii(brand), [0, 0, 0, 0], ascii('mif1'), ascii('heic'), new Array(32).fill(0))
}

export const buildGif = () => bytes(ascii('GIF89a'), new Array(16).fill(0))
export const asBlob = (b: Uint8Array, type = 'image/jpeg') => new Blob([b as BlobPart], { type })
