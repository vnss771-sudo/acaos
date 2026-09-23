// SSRF guard for user-configured outbound hosts (workspace SMTP/IMAP servers).
//
// String-prefix blocklists are not enough: a public hostname can resolve to a
// private/loopback/metadata address (DNS rebinding, internal-pointing domains),
// and IPv6 / IPv4-mapped / CGNAT forms slip past naive IPv4 regexes. This module
// classifies a literal IP as private, and resolves a hostname's A/AAAA records
// immediately before use so every resolved address is checked.

import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { ApiError } from './errors.js'

/** Parse a dotted IPv4 string into its four octets, or null if malformed. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

/** True for IPv4 ranges that must never be reachable from user config. */
function isPrivateIpv4(ip: string): boolean {
  const o = ipv4Octets(ip)
  if (!o) return false
  const [a, b] = o
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 127) return true // loopback
  if (a === 10) return true // private
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 169 && b === 254) return true // link-local + cloud metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a >= 224) return true // multicast + reserved (224.0.0.0+)
  return false
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null if malformed.
 * Handles `::` compression and a trailing dotted-IPv4 tail (::ffff:1.2.3.4).
 */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip
  const tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (tail) {
    const o = ipv4Octets(tail[1] as string)
    if (!o) return null
    const hi = ((o[0] << 8) | o[1]).toString(16)
    const lo = ((o[2] << 8) | o[3]).toString(16)
    s = `${s.slice(0, -(tail[1] as string).length)}${hi}:${lo}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)))
  const head = parse(halves[0] as string)
  const rest = halves.length === 2 ? parse(halves[1] as string) : []
  const fill = 8 - head.length - rest.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest]
  return groups.some((g) => Number.isNaN(g)) ? null : groups
}

/** Dotted IPv4 from two 16-bit groups. */
function hextetsToIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/**
 * True for an IP literal (v4 or v6) that points at private, loopback,
 * link-local, unique-local, or metadata space. IPv6 forms that carry an IPv4
 * address (mapped, compatible, SIIT, NAT64, 6to4, Teredo) are unwrapped and the
 * embedded IPv4 is checked, whether written dotted or in hex — WHATWG URL
 * parsing normalizes `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so a
 * dotted-only check would let a webhook URL reach the metadata endpoint.
 */
export function isPrivateIp(addr: string): boolean {
  let ip = addr.trim().toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  // Strip IPv6 zone id (e.g. fe80::1%eth0)
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)

  const kind = net.isIP(ip)
  if (kind === 4) return isPrivateIpv4(ip)
  if (kind !== 6) return false

  const h = ipv6Hextets(ip)
  if (!h) return true // net.isIP accepted it but we can't classify it — fail closed
  const zeroUpTo = (n: number) => h.slice(0, n).every((g) => g === 0)

  if (zeroUpTo(8)) return true // :: unspecified
  if (zeroUpTo(7) && h[7] === 1) return true // ::1 loopback
  // ::ffff:0:0/96 mapped, ::ffff:0:0:0/96 SIIT, ::/96 compatible (deprecated)
  if (zeroUpTo(5) && h[5] === 0xffff) return isPrivateIpv4(hextetsToIpv4(h[6]!, h[7]!))
  if (zeroUpTo(4) && h[4] === 0xffff && h[5] === 0) return isPrivateIpv4(hextetsToIpv4(h[6]!, h[7]!))
  if (zeroUpTo(6)) return isPrivateIpv4(hextetsToIpv4(h[6]!, h[7]!))
  // NAT64: 64:ff9b::/96 well-known prefix embeds IPv4; 64:ff9b:1::/48 is local-use
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    if (h.slice(2, 6).every((g) => g === 0)) return isPrivateIpv4(hextetsToIpv4(h[6]!, h[7]!))
    if (h[2] === 1) return true
  }
  if (h[0] === 0x2002) return isPrivateIpv4(hextetsToIpv4(h[1]!, h[2]!)) // 6to4 2002::/16
  if (h[0] === 0x2001 && h[1] === 0) return isPrivateIpv4(hextetsToIpv4(h[6]! ^ 0xffff, h[7]! ^ 0xffff)) // Teredo client

  const first = h[0]!
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * A validated, ready-to-connect target. `host` is the literal IP to dial; when
 * the caller supplied a hostname, `servername` carries the original name so TLS
 * SNI + certificate hostname verification still work against the pinned IP.
 */
export type PinnedHost = { host: string; servername?: string }

/**
 * Validate a user-supplied host and return the exact address to connect to.
 *
 * This is the SSRF-safe primitive: it resolves the hostname's A/AAAA records,
 * rejects the request if ANY resolved address is private/loopback/link-local/
 * metadata, and then returns ONE validated IP literal for the caller to dial
 * directly. Connecting by IP (with `servername` preserved for TLS) means the
 * mail library performs no second DNS lookup — closing the DNS-rebinding TOCTOU
 * window between the check and the connect. Literal-IP and IPv6/mapped bypasses
 * are rejected up front.
 *
 * @throws ApiError(400) for localhost, unresolvable hosts, or any private target.
 */
export async function resolvePublicMailHost(host: string, field = 'host'): Promise<PinnedHost> {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)

  if (!h) throw new ApiError(400, `${field}: host could not be resolved`)
  if (h === 'localhost' || h.endsWith('.localhost')) {
    throw new ApiError(400, `${field}: localhost not permitted`)
  }

  // Literal IP — classify directly, no DNS needed. Dial it as-is; there is no
  // hostname to verify a certificate against, so no servername.
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new ApiError(400, `${field}: private or reserved IP not permitted`)
    return { host: h }
  }

  let records: Array<{ address: string }>
  try {
    records = await lookup(h, { all: true })
  } catch {
    throw new ApiError(400, `${field}: host could not be resolved`)
  }
  if (records.length === 0) throw new ApiError(400, `${field}: host could not be resolved`)
  // Reject if ANY resolved address is private — a round-robin / split-horizon
  // record set must not let one public answer smuggle in a private sibling.
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new ApiError(400, `${field}: host resolves to a private or reserved address`)
    }
  }
  // Pin to the first validated address; preserve the original hostname for TLS.
  return { host: records[0]!.address, servername: h }
}

/**
 * Reject a user-supplied host that is, or resolves to, a non-public address.
 * Thin wrapper over {@link resolvePublicMailHost} for callers that only need the
 * validation side-effect (e.g. config-save time) and not the pinned address;
 * a no-op for empty input. Prefer {@link resolvePublicMailHost} at connect time
 * so the resolved IP is actually the one dialed (no TOCTOU re-resolution).
 */
export async function assertPublicMailHost(host: string | undefined | null, field = 'host'): Promise<void> {
  if (!host) return
  await resolvePublicMailHost(host, field)
}
