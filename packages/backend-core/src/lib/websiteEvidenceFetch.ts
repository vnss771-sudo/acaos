/** E3 stage 1: read-only website evidence transport. Not an outreach or consent decision. */
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { isPrivateIp } from './ssrf.js'

const MAX_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 8_000

export class WebsiteFetchError extends Error {
  constructor(public readonly reason: string, public readonly status?: number) {
    super(`Website collection rejected: ${reason}`)
    this.name = 'WebsiteFetchError'
  }
}

function parseTarget(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new WebsiteFetchError('invalid_url') }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.port && u.port !== '443') {
    throw new WebsiteFetchError('url_not_permitted')
  }
  // Avoid sending customer-supplied secrets in URL query parameters into logs or provenance.
  if (u.search || u.hash) throw new WebsiteFetchError('query_or_fragment_not_permitted')
  if (u.hostname.length > 253 || u.hostname === 'localhost' || u.hostname.endsWith('.localhost') ||
      u.hostname.endsWith('.local') || u.hostname.endsWith('.internal') || u.hostname.endsWith('.test') ||
      u.hostname.endsWith('.invalid') || u.hostname.endsWith('.example') || !u.hostname.includes('.')) {
    throw new WebsiteFetchError('hostname_not_permitted')
  }
  return u
}

// Network ranges not covered by generic mail SSRF classification, including benchmarks and documentation ranges.
function otherReservedV4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4) return false
  const [a, b, c] = o
  return (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) || (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 0)
}
function isAllowedIp(ip: string): boolean {
  if (!net.isIP(ip) || isPrivateIp(ip)) return false
  if (net.isIP(ip) === 4 && otherReservedV4(ip)) return false
  // Avoid IPv6 special-transition address forms until the egress policy can vet them fully.
  if (net.isIP(ip) === 6) return false
  return true
}

export type WebsiteDocument = Readonly<{
  sourceUrl: string
  retrievedAt: string
  contentType: string
  text: string
  bytes: number
  redirects: number
}>

export type FetchDependencies = {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  transport?: (url: URL, pinnedIp: string) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>
  now?: () => Date
}

/**
 * DNS lookup that always answers with the pre-validated pinned address. Node 20+ calls a custom `lookup` with
 * `{ all: true }` and expects an ARRAY; answering with the single-address form fails every request with
 * ERR_INVALID_IP_ADDRESS (verified on Node 26). Both call shapes are supported.
 */
export function pinnedLookup(pinnedIp: string) {
  return (_host: string, opts: { all?: boolean } | undefined, cb: (err: Error | null, address: unknown, family?: number) => void): void => {
    if (opts && opts.all) cb(null, [{ address: pinnedIp, family: 4 }])
    else cb(null, pinnedIp, 4)
  }
}

async function httpsTransport(url: URL, pinnedIp: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET', agent: false, timeout: TIMEOUT_MS,
      headers: { 'Accept': 'text/html, text/plain;q=0.9', 'User-Agent': 'ACAOS-EvidenceFetcher/1.0', 'Accept-Encoding': 'identity' },
      lookup: pinnedLookup(pinnedIp) as never,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) { req.destroy(new WebsiteFetchError('body_too_large')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new WebsiteFetchError('timeout')))
    // Total deadline (the socket timeout above is idle-only, so a slow trickle could otherwise run on).
    const deadline = setTimeout(() => req.destroy(new WebsiteFetchError('timeout')), TIMEOUT_MS)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end()
  })
}

/** Performs independent DNS validation on EVERY redirect; sockets dial only pinned IPv4 addresses. */
export async function collectWebsiteDocument(input: string, deps: FetchDependencies = {}): Promise<WebsiteDocument> {
  const resolve = deps.resolve ?? ((hostname: string) => lookup(hostname, { all: true }))
  const transport = deps.transport ?? httpsTransport
  const visited = new Set<string>()
  let url = parseTarget(input)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (visited.has(url.href)) throw new WebsiteFetchError('redirect_loop')
    visited.add(url.href)
    if (net.isIP(url.hostname)) throw new WebsiteFetchError('ip_literal_not_permitted')
    let addresses: Array<{ address: string; family: number }>
    try { addresses = await resolve(url.hostname) } catch { throw new WebsiteFetchError('dns_unavailable') }
    if (!addresses.length || addresses.some((r) => !isAllowedIp(r.address))) throw new WebsiteFetchError('non_public_address')
    const pinned = addresses.find((r) => r.family === 4)
    if (!pinned) throw new WebsiteFetchError('no_allowed_ipv4_address')
    let response: Awaited<ReturnType<typeof httpsTransport>>
    try { response = await transport(url, pinned.address) } catch (error) {
      if (error instanceof WebsiteFetchError) throw error
      throw new WebsiteFetchError('network_failure')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location
      if (typeof location !== 'string') throw new WebsiteFetchError('missing_redirect_location')
      if (redirects === MAX_REDIRECTS) throw new WebsiteFetchError('redirect_limit')
      url = parseTarget(new URL(location, url).href)
      continue
    }
    if (response.status !== 200) throw new WebsiteFetchError('upstream_status', response.status)
    const ct = response.headers['content-type']
    const contentType = Array.isArray(ct) ? ct[0] ?? '' : ct ?? ''
    if (!/^text\/(html|plain)(?:\s*;|\s*$)/i.test(contentType)) throw new WebsiteFetchError('unsupported_content_type')
    if (response.body.length > MAX_BYTES) throw new WebsiteFetchError('body_too_large')
    if (response.body.includes(0)) throw new WebsiteFetchError('binary_body')
    return { sourceUrl: url.href, retrievedAt: (deps.now?.() ?? new Date()).toISOString(), contentType, text: response.body.toString('utf8'), bytes: response.body.length, redirects }
  }
  throw new WebsiteFetchError('redirect_limit')
}
