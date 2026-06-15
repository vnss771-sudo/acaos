// Dependency liveness probes for the API health/readiness endpoints. Kept out of
// server.ts (which calls app.listen) so the probe logic is unit-testable, and so
// /api/ready and /api/health share one implementation instead of duplicating the
// DB round-trip.
import { prisma } from './prisma.js'
import { getRedis } from './redis.js'

export const PROBE_TIMEOUT_MS = 3000

// Reject after `ms` so a hung dependency can never stall a health probe (which
// would in turn make a load balancer's probe time out and flap the pod).
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), ms)),
  ])
}

// Database liveness: a trivial round-trip. Returns false (never throws) on any
// error or timeout so callers can treat it as a simple boolean.
export async function pingDatabase(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    await withTimeout(Promise.resolve(prisma.$queryRaw`SELECT 1`), timeoutMs)
    return true
  } catch {
    return false
  }
}

type Pingable = { status: string; ping: () => Promise<string> }

// Redis liveness: PING only when the shared client is already connected. A
// disconnected or erroring Redis is reported as down (never throws). Redis being
// down is a degraded-but-serving condition — the rate limiter falls back to an
// in-process counter — so callers report it without necessarily failing readiness.
export async function pingRedis(client: Pingable = getRedis(), timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    if (client.status !== 'ready') return false
    const res = await withTimeout(client.ping(), timeoutMs)
    return res === 'PONG'
  } catch {
    return false
  }
}
