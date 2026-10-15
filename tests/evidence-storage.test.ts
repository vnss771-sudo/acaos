// Unit tests (no database, no network) for the evidence-upload building blocks:
// fail-closed configuration, the S3 presigner's signed constraints, the in-memory
// store used by security tests, and the image validator/sanitiser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { resolveEvidenceStorage, describeEvidenceStorageProblems } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'
import {
  createS3EvidenceStore, MemoryEvidenceStore, newEvidenceKeys, assertKeyInWorkspace, setEvidenceStoreForTests,
} from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { sniffImageType, sanitizeEvidenceImage } from '../packages/backend-core/src/lib/evidenceImage.ts'

const GOOD = {
  EVIDENCE_UPLOADS_ENABLED: 'true',
  EVIDENCE_S3_ENDPOINT: 'https://storage.example.test',
  EVIDENCE_S3_BUCKET: 'acaos-evidence-test',
  EVIDENCE_S3_ACCESS_KEY_ID: 'AKIATESTACCESSKEYID',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'super-secret-value-do-not-leak',
}

// ── fail-closed configuration ────────────────────────────────────────────────

test('uploads are off unless the flag is exactly "true"', () => {
  for (const flag of [undefined, '', 'false', 'FALSE', ' false ']) {
    const s = resolveEvidenceStorage({ ...GOOD, EVIDENCE_UPLOADS_ENABLED: flag })
    assert.equal(s.enabled, false)
    assert.equal(!s.enabled && s.reason, 'flag_off')
  }
  assert.equal(resolveEvidenceStorage({}).enabled, false)
  assert.equal(resolveEvidenceStorage({ EVIDENCE_UPLOADS_ENABLED: 'true' }).enabled, false, 'flag without config is off')
})

test('a misspelt flag value does not enable uploads', () => {
  for (const flag of ['yes', '1', 'on', 'enabled', 'tru']) {
    const s = resolveEvidenceStorage({ ...GOOD, EVIDENCE_UPLOADS_ENABLED: flag })
    assert.equal(s.enabled, false, flag)
    assert.equal(!s.enabled && s.reason, 'invalid_config')
  }
})

test('valid configuration enables uploads with safe defaults', () => {
  const s = resolveEvidenceStorage(GOOD)
  assert.equal(s.enabled, true)
  if (!s.enabled) return
  assert.equal(s.config.maxUploadBytes, 10 * 1024 * 1024)
  assert.equal(s.config.presignTtlSeconds, 300)
  assert.equal(s.config.region, 'auto')
  assert.equal(s.config.forcePathStyle, false)
})

test('every missing or invalid setting disables uploads, and no problem text contains a secret', () => {
  const bad: Array<[string, Record<string, string | undefined>]> = [
    ['missing endpoint', { EVIDENCE_S3_ENDPOINT: undefined }],
    ['missing bucket', { EVIDENCE_S3_BUCKET: '' }],
    ['missing access key', { EVIDENCE_S3_ACCESS_KEY_ID: undefined }],
    ['missing secret', { EVIDENCE_S3_SECRET_ACCESS_KEY: undefined }],
    ['plain http endpoint', { EVIDENCE_S3_ENDPOINT: 'http://storage.example.test' }],
    ['ftp endpoint', { EVIDENCE_S3_ENDPOINT: 'ftp://storage.example.test' }],
    ['credentials in the endpoint', { EVIDENCE_S3_ENDPOINT: 'https://user:pw@storage.example.test' }],
    ['not a URL', { EVIDENCE_S3_ENDPOINT: 'storage' }],
    ['bad bucket name', { EVIDENCE_S3_BUCKET: 'Bad_Bucket!' }],
    ['non-numeric limit', { EVIDENCE_MAX_UPLOAD_BYTES: 'lots' }],
    ['limit too high', { EVIDENCE_MAX_UPLOAD_BYTES: String(26 * 1024 * 1024) }],
    ['limit too low', { EVIDENCE_PRESIGN_TTL_SECONDS: '1' }],
    ['ttl too long', { EVIDENCE_PRESIGN_TTL_SECONDS: '3600' }],
    ['negative limit', { EVIDENCE_MAX_FILES_PER_JOB: '-5' }],
    ['bad path-style flag', { EVIDENCE_S3_FORCE_PATH_STYLE: 'maybe' }],
  ]
  for (const [label, patch] of bad) {
    const s = resolveEvidenceStorage({ ...GOOD, ...patch })
    assert.equal(s.enabled, false, label)
    assert.equal(!s.enabled && s.reason, 'invalid_config', label)
    const text = JSON.stringify(s)
    assert.ok(!text.includes(GOOD.EVIDENCE_S3_SECRET_ACCESS_KEY), `${label}: leaked secret`)
    assert.ok(!text.includes(GOOD.EVIDENCE_S3_ACCESS_KEY_ID), `${label}: leaked key id`)
  }
})

test('http is allowed only for a loopback endpoint and never in production', () => {
  assert.equal(resolveEvidenceStorage({ ...GOOD, EVIDENCE_S3_ENDPOINT: 'http://127.0.0.1:9000' }).enabled, true)
  assert.equal(resolveEvidenceStorage({ ...GOOD, EVIDENCE_S3_ENDPOINT: 'http://localhost:9000' }).enabled, true)
  assert.equal(resolveEvidenceStorage({ ...GOOD, EVIDENCE_S3_ENDPOINT: 'http://127.0.0.1:9000', NODE_ENV: 'production' }).enabled, false)
})

test('the problem description is stable and names settings, not values', () => {
  const s = resolveEvidenceStorage({ ...GOOD, EVIDENCE_S3_BUCKET: undefined })
  const msg = describeEvidenceStorageProblems(s)
  assert.match(String(msg), /EVIDENCE_S3_BUCKET is required/)
  assert.equal(describeEvidenceStorageProblems(s), null, 'same problem set is logged once')
  assert.equal(describeEvidenceStorageProblems(resolveEvidenceStorage({})), null, 'flag-off is not an error')
})

// ── keys ────────────────────────────────────────────────────────────────────

test('object keys are workspace-prefixed, unguessable and distinct', () => {
  const a = newEvidenceKeys('wsA', 'job1')
  const b = newEvidenceKeys('wsA', 'job1')
  assert.match(a.uploadKey, /^ws\/wsA\/job\/job1\/upload\/[A-Za-z0-9_-]{32}$/)
  assert.match(a.primaryKey, /^ws\/wsA\/job\/job1\/final\/[A-Za-z0-9_-]{32}$/)
  assert.notEqual(a.uploadKey, b.uploadKey)
  assert.notEqual(a.primaryKey, a.uploadKey)
  assert.doesNotThrow(() => assertKeyInWorkspace(a.primaryKey, 'wsA'))
  assert.throws(() => assertKeyInWorkspace(a.primaryKey, 'wsB'))
  assert.throws(() => assertKeyInWorkspace('ws/wsA/../wsB/x', 'wsA'))
  assert.throws(() => assertKeyInWorkspace('ws/wsA//x', 'wsA'))
  assert.throws(() => assertKeyInWorkspace('other/wsA/x', 'wsA'))
})

// ── S3 presigner: the signature itself carries the constraints ────────────────

test('the real presigner binds key, size and type into a short-lived, secret-free URL', async () => {
  const cfg = { ...(resolveEvidenceStorage(GOOD) as { enabled: true; config: never }).config } as ReturnType<typeof Object>
  const store = createS3EvidenceStore(cfg as never)
  const { url, headers } = await store.presignPut({ key: 'ws/w1/job/j1/upload/abc', contentType: 'image/jpeg', contentLength: 12345, expiresInSeconds: 300 })
  const u = new URL(url)
  assert.equal(u.protocol, 'https:')
  assert.ok(u.hostname.includes('acaos-evidence-test') || u.pathname.includes('acaos-evidence-test'), 'bucket addressed')
  assert.ok(u.pathname.endsWith('ws/w1/job/j1/upload/abc'))
  assert.equal(u.searchParams.get('X-Amz-Expires'), '300')
  assert.equal(u.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256')
  const signed = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';')
  assert.ok(signed.includes('content-length') && signed.includes('content-type') && signed.includes('host'), `signed headers: ${signed}`)
  assert.equal(headers['Content-Length'], '12345')
  assert.equal(headers['Content-Type'], 'image/jpeg')
  assert.ok(!url.includes(GOOD.EVIDENCE_S3_SECRET_ACCESS_KEY), 'secret not in URL')
})

// ── in-memory store behaves like the signed service ──────────────────────────

test('the memory store refuses a forged size, forged type, expired or unknown URL', async () => {
  const store = new MemoryEvidenceStore()
  const body = Buffer.from('hello world')
  const s = await store.presignPut({ key: 'ws/w1/x', contentType: 'image/png', contentLength: body.length, expiresInSeconds: 60 })
  assert.equal(store.clientPut(s.url, Buffer.concat([body, Buffer.from('!')]), { ...s.headers, 'Content-Length': String(body.length + 1) }).status, 403, 'size')
  assert.equal(store.clientPut(s.url, body, { ...s.headers, 'Content-Type': 'text/html' }).status, 403, 'type')
  assert.equal(store.clientPut('memory://put/nope', body, s.headers).status, 403, 'unknown url')
  assert.equal(store.objects.size, 0)
  assert.equal(store.clientPut(s.url, body, s.headers).status, 200)
  assert.equal((await store.head('ws/w1/x'))?.size, body.length)
  store.now = () => Date.now() + 61_000
  assert.equal(store.clientPut(s.url, body, s.headers).status, 403, 'expired')
})

test('test store injection is refused in production', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try { assert.throws(() => setEvidenceStoreForTests(new MemoryEvidenceStore())) } finally { process.env.NODE_ENV = prev }
})

// ── image validation and sanitisation ─────────────────────────────────────────

const solid = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })
const OPTS = { maxPixels: 1_000_000 }

test('real type is sniffed from bytes, not trusted from the declaration', async () => {
  const jpeg = await solid().jpeg().toBuffer()
  const png = await solid().png().toBuffer()
  const webp = await solid().webp().toBuffer()
  assert.equal(sniffImageType(jpeg), 'image/jpeg')
  assert.equal(sniffImageType(png), 'image/png')
  assert.equal(sniffImageType(webp), 'image/webp')
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffImageType(Buffer.from('GIF89a......')), null)
  assert.equal(sniffImageType(Buffer.from('%PDF-1.7')), null)
  assert.equal(sniffImageType(Buffer.from('MZ\x90\x00')), null)
  assert.equal(sniffImageType(Buffer.alloc(0)), null)
})

test('forged metadata is rejected: wrong declared type, non-images, empty and truncated files', async () => {
  const jpeg = await solid().jpeg().toBuffer()
  const png = await solid().png().toBuffer()
  const reason = async (b: Buffer, declared: string) => {
    const r = await sanitizeEvidenceImage(b, { ...OPTS, declaredType: declared })
    return r.ok ? 'ok' : r.reason
  }
  assert.equal(await reason(png, 'image/jpeg'), 'type_mismatch')
  assert.equal(await reason(jpeg, 'image/png'), 'type_mismatch')
  assert.equal(await reason(Buffer.from('<svg onload="alert(1)"/>'), 'image/png'), 'unsupported_type')
  assert.equal(await reason(Buffer.from('<?php system($_GET[0]); ?>'), 'image/jpeg'), 'unsupported_type')
  assert.equal(await reason(Buffer.alloc(0), 'image/jpeg'), 'empty')
  // Right header, garbage body.
  assert.equal(await reason(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]), 'image/jpeg'), 'decode_failed')
  assert.equal(await reason(jpeg.subarray(0, Math.floor(jpeg.length / 3)), 'image/jpeg'), 'decode_failed')
})

test('images above the pixel limit are refused before decoding', async () => {
  const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#fff' } }).png().toBuffer()
  const r = await sanitizeEvidenceImage(big, { declaredType: 'image/png', maxPixels: 1_000_000 })
  assert.deepEqual(r, { ok: false, reason: 'too_many_pixels' })
  assert.equal((await sanitizeEvidenceImage(big, { declaredType: 'image/png', maxPixels: 4_000_000 })).ok, true)
})

test('EXIF and GPS are stripped and the output is a fresh JPEG', async () => {
  const exif = {
    IFD0: { Copyright: 'secret-owner-name', Artist: 'secret-artist' },
    IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 54/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 36/1' },
  }
  const input = await solid().jpeg().withExif(exif).toBuffer()
  assert.ok((await sharp(input).metadata()).exif, 'fixture really contains EXIF')
  assert.ok(input.includes('secret-owner-name'), 'fixture really contains the marker')
  const r = await sanitizeEvidenceImage(input, { ...OPTS, declaredType: 'image/jpeg' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const meta = await sharp(r.bytes).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.exif, undefined, 'no EXIF block')
  assert.equal(meta.icc, undefined)
  assert.ok(!r.bytes.includes('secret-owner-name') && !r.bytes.includes('secret-artist'), 'IFD0 text gone')
  assert.ok(!r.bytes.includes('GPS'), 'no GPS tags')
  assert.equal(r.contentType, 'image/jpeg')
  assert.match(r.sha256, /^[0-9a-f]{64}$/)
})

test('data appended after the image (a polyglot payload) does not survive re-encoding', async () => {
  const marker = '<?php system($_GET["c"]); ?>PK\u0003\u0004EVIL-ZIP-PAYLOAD'
  const jpeg = await solid().jpeg().toBuffer()
  const polyglot = Buffer.concat([jpeg, Buffer.from(marker)])
  const r = await sanitizeEvidenceImage(polyglot, { ...OPTS, declaredType: 'image/jpeg' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.ok(!r.bytes.includes('EVIL-ZIP-PAYLOAD') && !r.bytes.includes('system($_GET'))
})

test('large images are downscaled, orientation is applied, alpha is flattened, PNG and WebP become JPEG', async () => {
  const wide = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#a00' } }).png().toBuffer()
  const r = await sanitizeEvidenceImage(wide, { declaredType: 'image/png', maxPixels: 4_000_000 })
  assert.equal(r.ok && Math.max(r.width, r.height), 2048)
  const alpha = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
  const a = await sanitizeEvidenceImage(alpha, { ...OPTS, declaredType: 'image/png' })
  assert.equal(a.ok, true)
  if (a.ok) assert.equal((await sharp(a.bytes).metadata()).hasAlpha, false)
  const webp = await solid().webp().toBuffer()
  const w = await sanitizeEvidenceImage(webp, { ...OPTS, declaredType: 'image/webp' })
  assert.equal(w.ok && (await sharp(w.bytes).metadata()).format, 'jpeg')
  // EXIF orientation 6 (rotate 90): a 64x48 landscape becomes 48x64 portrait.
  const rotated = await solid(64, 48).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  assert.equal((await sharp(rotated).metadata()).orientation, 6, 'fixture really carries orientation 6')
  const o = await sanitizeEvidenceImage(rotated, { ...OPTS, declaredType: 'image/jpeg' })
  assert.equal(o.ok && `${o.width}x${o.height}`, '48x64')
})

test('re-encoding is deterministic for identical input (safe worker retries)', async () => {
  const input = await solid().jpeg().toBuffer()
  const a = await sanitizeEvidenceImage(input, { ...OPTS, declaredType: 'image/jpeg' })
  const b = await sanitizeEvidenceImage(input, { ...OPTS, declaredType: 'image/jpeg' })
  assert.ok(a.ok && b.ok && a.sha256 === b.sha256)
})

// ── S3 store operations, driven by a fake client (no network) ────────────────

import { Readable } from 'node:stream'
import { EvidenceObjectTooLargeError } from '../packages/backend-core/src/lib/evidenceStorage.ts'

function s3WithFake(handler: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) {
  const sent: Array<{ type: string; input: Record<string, unknown> }> = []
  const cfg = (resolveEvidenceStorage(GOOD) as { enabled: true; config: never }).config
  const store = createS3EvidenceStore(cfg, {
    send: async (cmd) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> }
      sent.push({ type: c.constructor.name, input: c.input })
      return handler(c)
    },
  })
  return { store, sent }
}
const awsError = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

test('head reports size, maps "not found" to null, and does not swallow other errors', async () => {
  const ok = s3WithFake(() => ({ ContentLength: 321 }))
  assert.deepEqual(await ok.store.head('ws/w1/k'), { size: 321 })
  assert.deepEqual(ok.sent[0], { type: 'HeadObjectCommand', input: { Bucket: 'acaos-evidence-test', Key: 'ws/w1/k' } })
  for (const e of [awsError('NotFound'), awsError('NoSuchKey'), awsError('Whatever', 404)]) {
    assert.equal(await s3WithFake(() => { throw e }).store.head('ws/w1/k'), null)
  }
  await assert.rejects(s3WithFake(() => { throw awsError('AccessDenied', 403) }).store.head('ws/w1/k'), /AccessDenied/)
})

test('getBytes returns the body, null when missing, and enforces the byte cap even if the length header lies', async () => {
  const body = Buffer.from('hello evidence')
  assert.deepEqual(await s3WithFake(() => ({ ContentLength: body.length, Body: Readable.from([body.subarray(0, 5), new Uint8Array(body.subarray(5))]) })).store.getBytes('ws/w1/k', 100), body)
  assert.equal(await s3WithFake(() => { throw awsError('NoSuchKey', 404) }).store.getBytes('ws/w1/k', 100), null)
  // Declared length already too big: refused before any bytes are read.
  let read = false
  const big = s3WithFake(() => ({ ContentLength: 5000, Body: new Readable({ read() { read = true; this.push(null) } }) }))
  await assert.rejects(big.store.getBytes('ws/w1/k', 100), EvidenceObjectTooLargeError)
  assert.equal(read, false)
  // Length header says small but the stream is larger: still stopped.
  const liar = s3WithFake(() => ({ ContentLength: 10, Body: Readable.from([Buffer.alloc(80, 1), Buffer.alloc(80, 2)]) }))
  await assert.rejects(liar.store.getBytes('ws/w1/k', 100), EvidenceObjectTooLargeError)
  await assert.rejects(s3WithFake(() => { throw awsError('InternalError', 500) }).store.getBytes('ws/w1/k', 100), /InternalError/)
})

test('putBytes and delete address the configured bucket with the exact key, type and length', async () => {
  const f = s3WithFake(() => ({}))
  await f.store.putBytes('ws/w1/job/j1/final/abc', Buffer.from('12345'), 'image/jpeg')
  await f.store.delete('ws/w1/job/j1/upload/def')
  assert.equal(f.sent[0].type, 'PutObjectCommand')
  assert.deepEqual({ ...f.sent[0].input, Body: undefined }, {
    Bucket: 'acaos-evidence-test', Key: 'ws/w1/job/j1/final/abc', Body: undefined, ContentType: 'image/jpeg', ContentLength: 5,
  })
  assert.deepEqual(f.sent[1], { type: 'DeleteObjectCommand', input: { Bucket: 'acaos-evidence-test', Key: 'ws/w1/job/j1/upload/def' } })
})

test('the memory store reads, writes, deletes, caps size, and can inject failures and concurrent events', async () => {
  const m = new MemoryEvidenceStore()
  const seen: string[] = []
  m.onPut = (k) => { seen.push(k) }
  await m.putBytes('ws/w1/a', Buffer.from('abcdef'), 'image/jpeg')
  assert.deepEqual(seen, ['ws/w1/a'])
  assert.deepEqual(await m.getBytes('ws/w1/a', 100), Buffer.from('abcdef'))
  await assert.rejects(m.getBytes('ws/w1/a', 3), EvidenceObjectTooLargeError)
  assert.equal(await m.getBytes('ws/w1/missing', 100), null)
  m.failNext = { op: 'delete', times: 1 }
  await assert.rejects(m.delete('ws/w1/a'), /injected delete failure/)
  await m.delete('ws/w1/a')
  assert.equal(await m.head('ws/w1/a'), null)
  assert.deepEqual(m.calls.filter(c => c === 'delete'), ['delete', 'delete'])
})
