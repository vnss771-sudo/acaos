import type { Redis } from 'ioredis'

// Cross-pod broadcast for ingestCache evictions, mirroring the shared-state
// pattern in packages/backend-core/src/lib/breakerStore.ts: a small factory
// over an injected Redis client, so it is unit-testable against a real Redis
// tier without the process-wide singleton, and every operation fails open —
// a Redis outage must never block a key rotation/revocation request, it just
// means sibling pods miss this one broadcast and fall back to their normal
// TTL expiry (unchanged from pre-existing per-pod behaviour).
//
// Rationale for pub/sub over a per-read Redis check: ingestCache exists
// specifically to avoid a DB round-trip on every high-volume ingest request;
// checking Redis on every cache hit would reintroduce a network round-trip on
// the hot path. Publishing only on the rare revoke/rotate/plan-change path
// keeps steady-state ingest fully in-process while still propagating a
// revocation to every pod within milliseconds instead of up to the full
// 5-minute TTL.

const CHANNEL = 'ingest-cache:invalidate'

export interface IngestCacheInvalidator {
  publish(hash: string): Promise<void>
  subscribe(onInvalidate: (hash: string) => void): Promise<void>
}

export function createIngestCacheInvalidator(pub: Redis, sub: Redis): IngestCacheInvalidator {
  return {
    async publish(hash) {
      try {
        await pub.publish(CHANNEL, hash)
      } catch {
        // fail-open: this pod already evicted locally; siblings miss the
        // broadcast and fall back to normal TTL expiry.
      }
    },
    async subscribe(onInvalidate) {
      sub.on('message', (channel: string, message: string) => {
        if (channel === CHANNEL) onInvalidate(message)
      })
      try {
        await sub.subscribe(CHANNEL)
      } catch {
        // fail-open: this pod just won't receive cross-pod invalidations.
      }
    },
  }
}
