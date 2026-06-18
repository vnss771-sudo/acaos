/**
 * True for an IP literal (v4 or v6) that points at private, loopback,
 * link-local, unique-local, or metadata space. IPv4-mapped IPv6 addresses are
 * unwrapped and checked as IPv4.
 */
export declare function isPrivateIp(addr: string): boolean;
/**
 * Reject a user-supplied host that is, or resolves to, a non-public address.
 * Call immediately before connecting (resolve-then-use) so the check covers
 * hostnames whose DNS points inward, not just literal private IPs. A small
 * TOCTOU window remains versus full connect-time IP pinning, but this closes the
 * DNS-resolves-to-private and IPv6/mapped bypasses entirely.
 */
export declare function assertPublicMailHost(host: string | undefined | null, field?: string): Promise<void>;
