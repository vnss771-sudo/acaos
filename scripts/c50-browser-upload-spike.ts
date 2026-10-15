// C5.0: browser upload compatibility check for the evidence presigned-PUT design.
//
//   ACAOS_SPIKE_ENDPOINT=http://127.0.0.1:19000 ACAOS_SPIKE_BUCKET=spike \
//   ACAOS_SPIKE_KEY_ID=... ACAOS_SPIKE_SECRET=... npx tsx scripts/c50-browser-upload-spike.ts
//
// What it does: signs URLs with the REAL production presigner (createS3EvidenceStore), then drives
// headless Chromium on a different origin to upload and download through a logging reverse proxy in
// front of the S3-compatible server, so the exact preflight and PUT requests the browser sends are
// recorded. It prints a JSON report. It only ever writes under the key prefix `spike/`, in an empty
// disposable bucket you point it at; it refuses an endpoint that is not loopback unless
// ACAOS_SPIKE_ALLOW_REMOTE=1 (for the approved staging buckets, whose CORS must allow the page origin
// http://127.0.0.1:5199). It never reads production configuration.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { S3Client, CreateBucketCommand, PutBucketCorsCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { createS3EvidenceStore } from '../packages/backend-core/src/lib/evidenceStorage.ts'

const env = process.env
const ENDPOINT = env.ACAOS_SPIKE_ENDPOINT ?? 'http://127.0.0.1:19000'
const BUCKET = env.ACAOS_SPIKE_BUCKET ?? 'spike'
const KEY_ID = env.ACAOS_SPIKE_KEY_ID ?? ''
const SECRET = env.ACAOS_SPIKE_SECRET ?? ''
const PAGE_PORT = 5199
const PROXY_PORT = 19001
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`
if (!KEY_ID || !SECRET) throw new Error('set ACAOS_SPIKE_KEY_ID and ACAOS_SPIKE_SECRET (disposable bucket credentials)')
const target = new URL(ENDPOINT)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) && env.ACAOS_SPIKE_ALLOW_REMOTE !== '1') {
  throw new Error('refusing a non-loopback endpoint without ACAOS_SPIKE_ALLOW_REMOTE=1')
}
const LOCAL = ['127.0.0.1', 'localhost'].includes(target.hostname)

// ── logging reverse proxy: sees exactly what the browser sends ──────────────
type Logged = { method: string; path: string; status: number; reqHeaders: Record<string, string>; bodyBytes: number; resHeaders: Record<string, string> }
const log: Logged[] = []
let killAfterBytes: number | null = null // simulate a dropped connection mid-upload
let killTimes = 0
const proxy = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  let bytes = 0
  let killed = false
  req.on('data', (c: Buffer) => {
    bytes += c.length
    chunks.push(c)
    if (killAfterBytes != null && killTimes > 0 && bytes >= killAfterBytes && !killed) {
      killed = true; if (--killTimes === 0) { killAfterBytes = null }
      log.push({ method: req.method!, path: (req.url ?? '').split('?')[0], status: -1, reqHeaders: pickReq(req), bodyBytes: bytes, resHeaders: {} })
      req.socket.destroy()
    }
  })
  req.on('end', () => {
    if (killed) return
    const go = () => {
      const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        const out: Buffer[] = []
        ur.on('data', (c: Buffer) => out.push(c))
        ur.on('end', () => {
          log.push({ method: req.method!, path: (req.url ?? '').split('?')[0], status: ur.statusCode ?? 0, reqHeaders: pickReq(req), bodyBytes: bytes, resHeaders: pickRes(ur) })
          res.writeHead(ur.statusCode ?? 502, ur.headers); res.end(Buffer.concat(out))
        })
      })
      up.on('error', () => { res.writeHead(502); res.end() })
      up.end(Buffer.concat(chunks))
    }
    go()
  })
})
const pickReq = (r: http.IncomingMessage) => Object.fromEntries(['origin', 'content-type', 'content-length', 'access-control-request-method', 'access-control-request-headers', 'x-amz-acl', 'referer']
  .filter((k) => r.headers[k] !== undefined).map((k) => [k, String(r.headers[k])]))
const pickRes = (r: http.IncomingMessage) => Object.fromEntries(['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age', 'content-type', 'content-disposition', 'cache-control', 'etag']
  .filter((k) => r.headers[k] !== undefined).map((k) => [k, String(r.headers[k])]))

// The URL the browser uses goes through the proxy; the Host header is preserved so SigV4 still verifies.
const store = createS3EvidenceStore({ endpoint: `http://${target.hostname}:${PROXY_PORT}`, bucket: BUCKET, region: 'us-east-1', accessKeyId: KEY_ID, secretAccessKey: SECRET, forcePathStyle: true })
const admin = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } })
const exists = async (key: string) => { try { return Number((await admin.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))).ContentLength) } catch { return null } }
const key = (n: string) => `spike/ws/wsA/job/j1/upload/${n}-${randomBytes(6).toString('hex')}`

const jpeg = (w = 1600, h = 1200) => sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 85 }).toBuffer()

type Row = { id: string; name: string; expected: string; observed: unknown; pass: boolean }
const rows: Row[] = []
const rec = (id: string, name: string, expected: string, observed: unknown, pass: boolean) => { rows.push({ id, name, expected, observed, pass }); console.error(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}`) }

// ── page-side helper (runs in Chromium) ─────────────────────────────────────
const PAGE_HELPER = `
window.xput = (url, headers, b64, type, opts) => new Promise((resolve) => {
  opts = opts || {}
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const body = new Blob([bin], type ? { type } : {})
  const x = new XMLHttpRequest()
  const out = { status: 0, progress: 0, lastLoaded: 0, total: 0, aborted: false, errored: false, text: '', etag: null }
  x.open('PUT', url)
  for (const [k, v] of Object.entries(headers || {})) { try { x.setRequestHeader(k, v) } catch (e) { out['hdr_'+k] = String(e.message) } }
  x.upload.onprogress = (e) => { out.progress++; out.lastLoaded = e.loaded; out.total = e.total }
  x.onload = () => { out.status = x.status; out.text = x.responseText.slice(0, 200); out.etag = x.getResponseHeader('ETag'); resolve(out) }
  x.onerror = () => { out.errored = true; resolve(out) }
  x.onabort = () => { out.aborted = true; resolve(out) }
  x.ontimeout = () => { out.timeout = true; resolve(out) }
  if (opts.abortAfterMs) setTimeout(() => x.abort(), opts.abortAfterMs)
  x.send(body)
})
window.xget = async (url) => { try { const r = await fetch(url, { referrerPolicy: 'no-referrer' }); const b = await r.arrayBuffer(); return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), cache: r.headers.get('cache-control'), len: b.byteLength } } catch (e) { return { error: String(e) } } }
window.img = (url) => new Promise((res) => { const i = new Image(); i.referrerPolicy = 'no-referrer'; i.onload = () => res({ ok: true, w: i.naturalWidth }); i.onerror = () => res({ ok: false }); i.src = url })
`

async function main() {
  // bucket + CORS for the page origin (disposable bucket only)
  if (LOCAL) {
    try { await admin.send(new CreateBucketCommand({ Bucket: BUCKET })) } catch { /* exists */ }
    await admin.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: { CORSRules: [{
      AllowedOrigins: [PAGE_ORIGIN], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type', 'content-length'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 600,
    }] } }))
  }
  await new Promise<void>((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r))
  const pageSrv = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>spike</title>') })
  await new Promise<void>((r) => pageSrv.listen(PAGE_PORT, '127.0.0.1', r))

  const browser = await chromium.launch(env.ACAOS_SPIKE_CHROMIUM ? { executablePath: env.ACAOS_SPIKE_CHROMIUM } : {})
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const consoleErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
  await page.goto(PAGE_ORIGIN + '/')
  await page.evaluate(PAGE_HELPER)
  const cdp = await ctx.newCDPSession(page)
  const bytes = await jpeg()
  const b64 = bytes.toString('base64')
  const mark = () => log.length
  const since = (m: number) => log.slice(m)
  const bodyOf = (u: string) => store.presignPut({ key: u, contentType: 'image/jpeg', contentLength: bytes.length, expiresInSeconds: 300 })
  const put = (url: string, headers: Record<string, string>, data = b64, type: string | null = 'image/jpeg', opts: object = {}) =>
    page.evaluate(([u, h, d, t, o]) => (window as any).xput(u, h, d, t, o), [url, headers, data, type, opts] as const) as Promise<any>

  // T1 happy path: signed headers, Content-Length attempted from script (forbidden header in browsers)
  {
    const k = key('t1'); const s = await bodyOf(k); const m = mark()
    const r = await put(s.url, s.headers)
    const entries = since(m)
    const pre = entries.find((e) => e.method === 'OPTIONS'); const pu = entries.find((e) => e.method === 'PUT')
    const signedHdrs = new URL(s.url).searchParams.get('X-Amz-SignedHeaders')
    rec('T1', 'browser XHR PUT with the exact signed headers succeeds cross-origin', '200, ETag readable, content-length/type signed', {
      status: r.status, etag: r.etag, progressEvents: r.progress > 0, signedHeaders: signedHdrs,
      scriptContentLengthRefused: r['hdr_Content-Length'] ?? 'setRequestHeader accepted (browser ignores/overrides it)',
      preflight: pre ? { status: pre.status, requestHeaders: pre.reqHeaders['access-control-request-headers'], allowHeaders: pre.resHeaders['access-control-allow-headers'], allowMethods: pre.resHeaders['access-control-allow-methods'], maxAge: pre.resHeaders['access-control-max-age'] } : 'none seen',
      putRequest: pu ? { contentType: pu.reqHeaders['content-type'], contentLength: pu.reqHeaders['content-length'], origin: pu.reqHeaders['origin'] } : null,
      stored: await exists(k), declaredSize: bytes.length,
    }, r.status === 200 && (await exists(k)) === bytes.length && pu?.reqHeaders['content-length'] === String(bytes.length) && Boolean(pre) && /content-type/.test(pre?.reqHeaders['access-control-request-headers'] ?? '') && !/content-length/.test(pre?.reqHeaders['access-control-request-headers'] ?? ''))
  }

  // T2 no explicit Content-Type header: the Blob's own type is sent
  {
    const k = key('t2'); const s = await bodyOf(k); const m = mark()
    const r = await put(s.url, {}, b64, 'image/jpeg')
    const pu = since(m).find((e) => e.method === 'PUT')
    rec('T2', 'Blob type alone (no explicit header) is sent as the signed Content-Type', '200 and content-type exactly image/jpeg', { status: r.status, sentContentType: pu?.reqHeaders['content-type'] }, r.status === 200 && pu?.reqHeaders['content-type'] === 'image/jpeg')
    const k2 = key('t2b'); const s2 = await bodyOf(k2)
    const r2 = await put(s2.url, {}, b64, null)
    rec('T2b', 'a Blob with NO type and no header is refused (the browser sends no usable Content-Type)', 'not 200', { status: r2.status, stored: await exists(k2) }, r2.status !== 200 && (await exists(k2)) === null)
  }

  // T3/T4 forged type and size
  {
    const k = key('t3'); const s = await bodyOf(k)
    const wrongType = await put(s.url, { 'Content-Type': 'text/html' }, b64, 'text/html')
    const png = await put(s.url, { 'Content-Type': 'image/png' }, b64, 'image/png')
    rec('T3', 'a different Content-Type than the one signed is refused', '403, nothing stored', { html: wrongType.status, png: png.status, stored: await exists(k) }, wrongType.status === 403 && png.status === 403 && (await exists(k)) === null)
    const bigger = Buffer.concat([bytes, Buffer.alloc(1)]).toString('base64')
    const smaller = bytes.subarray(0, bytes.length - 1).toString('base64')
    const big = await put(s.url, s.headers, bigger); const small = await put(s.url, s.headers, smaller)
    rec('T4', 'a body one byte larger or smaller than the signed length is refused', '403, nothing stored', { larger: big.status, smaller: small.status, stored: await exists(k) }, big.status === 403 && small.status === 403 && (await exists(k)) === null)
  }

  // T5 extra unsigned header: the CORS allow-list stops the browser and nothing public is created
  {
    const k = key('t5'); const s = await bodyOf(k); const m = mark()
    const r = await put(s.url, { ...s.headers, 'x-amz-acl': 'public-read' })
    const anon = await fetch(`http://${target.hostname}:${PROXY_PORT}/${BUCKET}/${k}`).then((x) => x.status)
    rec('T5', 'an extra x-amz-acl: public-read header is blocked by the CORS allow-list, and the object is never public', 'browser blocks (status 0), nothing stored, anonymous GET 403/404', {
      status: r.status, errored: r.errored, requestsSeen: since(m).map((e) => `${e.method} ${e.status}`), stored: await exists(k), anonymousGet: anon,
    }, r.status === 0 && (await exists(k)) === null && [403, 404].includes(anon))
  }

  // T6 expiry and tampering
  {
    const k = key('t6'); const short = await store.presignPut({ key: k, contentType: 'image/jpeg', contentLength: bytes.length, expiresInSeconds: 1 })
    await new Promise((r) => setTimeout(r, 2500))
    const expired = await put(short.url, short.headers)
    rec('T6', 'an expired signature is refused', '403, nothing stored', { status: expired.status, text: expired.text.slice(0, 90), stored: await exists(k) }, expired.status === 403 && (await exists(k)) === null)
    const s = await bodyOf(key('t6b'))
    const u = new URL(s.url)
    const swap = new URL(s.url); swap.pathname = swap.pathname.replace(/\/[^/]*$/, '/other-object')
    const longer = new URL(s.url); longer.searchParams.set('X-Amz-Expires', '99999')
    const nosig = new URL(s.url); nosig.searchParams.delete('X-Amz-Signature')
    const r1 = await put(swap.toString(), s.headers); const r2 = await put(longer.toString(), s.headers); const r3 = await put(nosig.toString(), s.headers)
    rec('T6b', 'modified key, extended expiry and a stripped signature are refused', '400/403 each, nothing stored', { otherKey: r1.status, longerExpiry: r2.status, noSignature: r3.status, pathWas: u.pathname.slice(-20) }, [r1, r2, r3].every((r) => r.status === 403 || r.status === 400))
  }

  // T7 cancellation and interruption
  {
    const big = await jpeg(5000, 4000)
    const bigB64 = big.toString('base64')
    const sg = await store.presignPut({ key: key('t7'), contentType: 'image/jpeg', contentLength: big.length, expiresInSeconds: 300 })
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 1_000_000, uploadThroughput: 150_000 })
    const aborted = await put(sg.url, sg.headers, bigB64, 'image/jpeg', { abortAfterMs: 1200 })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    const k7 = new URL(sg.url).pathname.replace(`/${BUCKET}/`, '')
    rec('T7', 'cancelling (xhr.abort) a slow upload fires onabort and stores nothing', 'aborted, no object', { aborted: aborted.aborted, progressEvents: aborted.progress, sentBytes: aborted.lastLoaded, ofBytes: big.length, stored: await exists(k7) }, aborted.aborted && (await exists(k7)) === null)
    const retry = await put(sg.url, sg.headers, bigB64)
    rec('T7b', 'the same signed URL can be retried after a cancel (within its lifetime) and completes', '200, full size stored', { status: retry.status, stored: await exists(k7), size: big.length }, retry.status === 200 && (await exists(k7)) === big.length)

    const sk = await store.presignPut({ key: key('t8'), contentType: 'image/jpeg', contentLength: bytes.length, expiresInSeconds: 300 })
    const k8 = new URL(sk.url).pathname.replace(`/${BUCKET}/`, '')
    // One dropped connection: Chromium transparently retries an idempotent PUT once, so the page may never see it.
    killAfterBytes = Math.floor(bytes.length / 3); killTimes = 1
    const m8 = mark()
    const once = await put(sk.url, sk.headers)
    const attempts = since(m8).filter((e) => e.method === 'PUT')
    rec('T8a', 'one dropped connection mid-upload: Chromium retries the PUT itself (the page may see success after two wire attempts)', 'either success after a transparent retry or a network error; never a partial object', { status: once.status, errored: once.errored, putAttemptsOnTheWire: attempts.length, firstAttemptKilled: attempts[0]?.status === -1, stored: await exists(k8) }, (once.status === 200 && (await exists(k8)) === bytes.length) || (once.status === 0 && (await exists(k8)) === null))
    await store.presignPut({ key: k8, contentType: 'image/jpeg', contentLength: bytes.length, expiresInSeconds: 300 })
    // Two consecutive drops defeat the transparent retry and must surface to the page as an error with nothing stored.
    const k8b = key('t8b'); const sk2 = await bodyOf(k8b)
    killAfterBytes = Math.floor(bytes.length / 3); killTimes = 2
    const cut = await put(sk2.url, sk2.headers)
    killAfterBytes = null; killTimes = 0
    rec('T8', 'repeated dropped connections surface as a network error (status 0) and store nothing', 'status 0 / onerror, no object', { status: cut.status, errored: cut.errored, stored: await exists(k8b) }, cut.status === 0 && cut.errored && (await exists(k8b)) === null)
    const again2 = await put(sk2.url, sk2.headers)
    rec('T8c', 'retrying the same URL after repeated drops succeeds', '200, full size stored', { status: again2.status, stored: await exists(k8b) }, again2.status === 200 && (await exists(k8b)) === bytes.length)

    await ctx.setOffline(true)
    const off = await put(sk.url, sk.headers)
    await ctx.setOffline(false)
    const back = await put(sk.url, sk.headers)
    rec('T9', 'offline fails fast as a network error; back online the retry succeeds and re-writing the same key is idempotent', 'offline status 0; then 200; one object of the right size', { offline: { status: off.status, errored: off.errored }, online: back.status, stored: await exists(k8) }, off.status === 0 && off.errored && back.status === 200 && (await exists(k8)) === bytes.length)
    const fresh = await store.presignPut({ key: k8, contentType: 'image/jpeg', contentLength: bytes.length, expiresInSeconds: 300 })
    const overwrite = await put(fresh.url, fresh.headers)
    rec('T9b', 'a re-issued signed URL for the same key (the re-init path) overwrites it with identical bytes', '200, size unchanged', { status: overwrite.status, stored: await exists(k8) }, overwrite.status === 200 && (await exists(k8)) === bytes.length)
  }

  // T10 no unintended public access and no cross-workspace use of a signature
  {
    const k = key('t10'); const s = await bodyOf(k); await put(s.url, s.headers)
    const base = `http://${target.hostname}:${PROXY_PORT}/${BUCKET}`
    const anonGet = (await fetch(`${base}/${k}`)).status
    const anonHead = (await fetch(`${base}/${k}`, { method: 'HEAD' })).status
    const anonList = (await fetch(`${base}?list-type=2&prefix=spike/`)).status
    const anonPut = (await fetch(`${base}/${key('anon')}`, { method: 'PUT', body: 'x' })).status
    const wrongMethod = (await fetch(s.url)).status // presigned PUT URL used for GET
    const otherWs = new URL(s.url); otherWs.pathname = otherWs.pathname.replace('/ws/wsA/', '/ws/wsB/')
    const crossPut = await put(otherWs.toString(), s.headers)
    const signedGet = await store.presignGet({ key: k, expiresInSeconds: 60, contentType: 'image/jpeg' })
    const otherGet = new URL(signedGet.url); otherGet.pathname = otherGet.pathname.replace('/ws/wsA/', '/ws/wsB/')
    rec('T10', 'no anonymous read, list or write; a signature cannot be reused for another method or another workspace prefix', '403/404 everywhere', {
      anonymousGet: anonGet, anonymousHead: anonHead, anonymousList: anonList, anonymousPut: anonPut, putUrlUsedForGet: wrongMethod,
      putUrlRepointedToWorkspaceB: crossPut.status, getUrlRepointedToWorkspaceB: (await fetch(otherGet.toString())).status,
    }, [anonGet, anonHead, anonList, anonPut, wrongMethod, crossPut.status].every((c) => [401, 403, 404, 405].includes(c)))
  }

  // T11 signed GET: forced response headers, cross-origin fetch, <img>, and referrer
  {
    const k = key('t11'); const s = await bodyOf(k); await put(s.url, s.headers)
    const g = await store.presignGet({ key: k, expiresInSeconds: 60, contentType: 'image/jpeg' })
    const m = mark()
    const f = await page.evaluate((u) => (window as any).xget(u), g.url) as any
    const wire = since(m).find((e) => e.method === 'GET' && e.resHeaders['content-disposition'])
    const im = await page.evaluate((u) => (window as any).img(u), g.url) as any
    const reqs = since(m).filter((e) => e.method === 'GET')
    rec('T11', 'signed GET: forced headers, readable cross-origin, usable in <img>, no Referer sent', 'type image/jpeg, inline, no-store; image loads; no referer', {
      fetch: f, img: im, refererSent: reqs.some((e) => e.reqHeaders['referer']), getRequests: reqs.length,
      dispositionOnTheWire: wire?.resHeaders['content-disposition'], dispositionVisibleToScript: f.disp,
      note: 'Content-Disposition is not CORS-safelisted, so script cannot read it unless the bucket exposes it; <img> does not need it',
    }, f.status === 200 && f.type === 'image/jpeg' && /no-store/.test(f.cache ?? '') && /^inline/.test(wire?.resHeaders['content-disposition'] ?? '') && im.ok && !reqs.some((e) => e.reqHeaders['referer']))
  }

  // T12 a page origin that is not allow-listed cannot upload
  {
    const other = await ctx.newPage()
    const o2 = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html>') })
    await new Promise<void>((r) => o2.listen(5198, '127.0.0.1', r))
    await other.goto('http://127.0.0.1:5198/'); await other.evaluate(PAGE_HELPER)
    const k = key('t12'); const s = await bodyOf(k)
    const r = await other.evaluate(([u, h, d]) => (window as any).xput(u, h, d, 'image/jpeg'), [s.url, s.headers, b64] as const) as any
    rec('T12', 'a page on a non-allow-listed origin is blocked by CORS and nothing is stored', 'status 0, nothing stored', { status: r.status, errored: r.errored, stored: await exists(k) }, r.status === 0 && (await exists(k)) === null)
    await new Promise<void>((r2) => o2.close(() => r2())); await other.close()
  }

  await browser.close(); proxy.close(); pageSrv.close()
  const report = {
    when: new Date().toISOString(), server: ENDPOINT, local: LOCAL, chromium: 'Playwright bundled Chromium (headless)',
    caveat: 'Run against a local SeaweedFS S3 server. Behaviour of Railway Buckets and Cloudflare R2 must be re-measured with this same script on the approved staging buckets.',
    passed: rows.filter((r) => r.pass).length, failed: rows.filter((r) => !r.pass).length, rows, consoleErrorsSample: consoleErrors.slice(0, 6),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
