// Runs INSIDE the production worker image (see the "Smoke-test worker image" step in
// .github/workflows/ci.yml): verifies sharp's musl binary loads and that evidence photos
// are validated and re-encoded the way finalisation does it (EXIF/GPS stripped, hostile
// inputs refused). Paths are the image's (/app). Exits non-zero on any failure.
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire('/app/packages/backend-core/dist/lib/evidenceImage.js')
console.log('os:', fs.readFileSync('/etc/os-release', 'utf8').split('\n')[0], '| node', process.version, '| uid', process.getuid())
if (process.getuid() === 0) { console.error('worker image must run as an unprivileged user'); process.exit(1) }
const sharp = require('sharp')
console.log('sharp', sharp.versions.sharp, 'vips', sharp.versions.vips, 'libc musl pkg:', Object.keys(require('module')._pathCache || {}).length >= 0)
const { sanitizeEvidenceImage } = await import('/app/packages/backend-core/dist/lib/evidenceImage.js')
const withGps = async (fmt) => sharp({ create: { width: 640, height: 480, channels: 3, background: '#336699' } })[fmt]().withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' } }).toBuffer()
let ok = true
for (const [fmt, type] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
  const input = await withGps(fmt)
  const had = (await sharp(input).metadata()).exif ? 'EXIF-in' : 'no-exif-in'
  const r = await sanitizeEvidenceImage(input, { declaredType: type, maxPixels: 25_000_000 })
  if (!r.ok) { console.log(fmt, 'REJECTED', r.reason); ok = false; continue }
  const m = await sharp(r.bytes).metadata()
  const pass = m.format === 'jpeg' && !m.exif && m.width === 640 && m.height === 480 && !r.bytes.includes(Buffer.from('secret-owner'))
  console.log(fmt, '->', m.format, `${m.width}x${m.height}`, had, 'out-exif:', !!m.exif, 'sha', r.sha256.slice(0, 12), pass ? 'PASS' : 'FAIL'); ok &&= pass
}
// hostile inputs
const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#fff' } }).png().toBuffer()
const rb = await sanitizeEvidenceImage(bomb, { declaredType: 'image/png', maxPixels: 25_000_000 }); console.log('36MP png ->', rb.ok ? 'ACCEPTED (FAIL)' : rb.reason); ok &&= !rb.ok
const trailing = Buffer.concat([await withGps('jpeg'), Buffer.from('<?php system($_GET[0]); ?>')])
const rt = await sanitizeEvidenceImage(trailing, { declaredType: 'image/jpeg', maxPixels: 25_000_000 }); console.log('trailing payload ->', rt.ok ? (rt.bytes.includes(Buffer.from('<?php')) ? 'PAYLOAD KEPT (FAIL)' : 'dropped PASS') : rt.reason); ok &&= rt.ok && !rt.bytes.includes(Buffer.from('<?php'))
const rm = await sanitizeEvidenceImage(await withGps('png'), { declaredType: 'image/jpeg', maxPixels: 25_000_000 }); console.log('png declared as jpeg ->', rm.ok ? 'ACCEPTED (FAIL)' : rm.reason); ok &&= !rm.ok
const rg = await sanitizeEvidenceImage(Buffer.from('GIF89a not an image'), { declaredType: 'image/gif', maxPixels: 25_000_000 }); console.log('gif/garbage ->', rg.ok ? 'ACCEPTED (FAIL)' : rg.reason); ok &&= !rg.ok
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL'); process.exit(ok ? 0 : 1)
