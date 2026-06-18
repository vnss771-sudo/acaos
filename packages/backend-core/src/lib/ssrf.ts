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
 * True for an IP literal (v4 or v6) that points at private, loopback,
 * link-local, unique-local, or metadata space. IPv4-mapped IPv6 addresses are
 * unwrapped and checked as IPv4.
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

  // IPv4-mapped / -compatible IPv6: ::ffff:1.2.3.4 or ::ffff:0:1.2.3.4
  const mapped = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped && (ip.startsWith('::ffff:') || ip.startsWith('::'))) {
    return isPrivateIpv4(mapped[1] as string)
  }

  if (ip === '::1' || ip === '::') return true // loopback / unspecified
  if (ip.startsWith('fe80') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true // fe80::/10 link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true // fc00::/7 unique-local
  if (ip.startsWith('ff')) return true // ff00::/8 multicast
  return false
}

/**
 * Reject a user-supplied host that is, or resolves to, a non-public address.
 * Call immediately before connecting (resolve-then-use) so the check covers
 * hostnames whose DNS points inward, not just literal private IPs. A small
 * TOCTOU window remains versus full connect-time IP pinning, but this closes the
 * DNS-resolves-to-private and IPv6/mapped bypasses entirely.
 */
export async function assertPublicMailHost(host: string | undefined | null, field = 'host'): Promise<void> {
  if (!host) return
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)

  if (h === 'localhost' || h.endsWith('.localhost')) {
    throw new ApiError(400, `${field}: localhost not permitted`)
  }

  // Literal IP — classify directly, no DNS needed.
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new ApiError(400, `${field}: private or reserved IP not permitted`)
    return
  }

  let records: Array<{ address: string }>
  try {
    records = await lookup(h, { all: true })
  } catch {
    throw new ApiError(400, `${field}: host could not be resolved`)
  }
  if (records.length === 0) throw new ApiError(400, `${field}: host could not be resolved`)
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new ApiError(400, `${field}: host resolves to a private or reserved address`)
    }
  }
}
