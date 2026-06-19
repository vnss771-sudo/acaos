// Simple circuit breaker for external service calls (OpenAI, Stripe, Apollo).
// CLOSED → normal operation. After `threshold` consecutive failures, trips OPEN.
// After `resetAfterMs` of silence, probes with HALF_OPEN. Success → CLOSED.

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export class CircuitOpenError extends Error {
  constructor(label: string, public readonly retryAfterMs: number) {
    super(`${label} temporarily unavailable — circuit open`)
    this.name = 'CircuitOpenError'
  }
}

// Optional cross-process state for the breaker. Backed by Redis in production
// (see breakerStore.ts) so that when one process (e.g. the worker) trips a
// provider's circuit, sibling processes (the API, other replicas) stop hammering
// it too. Every method MUST fail-open — a store error must never block a call or
// throw — so the breaker degrades gracefully to per-process behaviour if the
// shared store is unavailable.
export interface BreakerStore {
  // Epoch-ms until which this label is considered open across processes. Returns
  // 0 (or a past timestamp) when the circuit is not shared-open.
  getOpenUntil(label: string): Promise<number>
  // Best-effort broadcast that this label is open until `untilMs`.
  setOpenUntil(label: string, untilMs: number): Promise<void>
}

export class CircuitBreaker {
  private failures = 0
  private lastFailureAt = 0
  private state: State = 'CLOSED'
  // True while a single HALF_OPEN probe is in flight. Prevents a thundering herd
  // of concurrent probes all hitting a still-recovering provider — a correct
  // breaker allows exactly one probe at a time.
  private probing = false

  // Optional shared store. When set, a CLOSED breaker adopts the OPEN state a
  // sibling process has published, and broadcasts its own trips. The shared read
  // is throttled to at most once per `syncIntervalMs` so the hot path adds at
  // most one (fail-open) Redis GET per second per label per process — not a
  // round-trip on every call. When unset, behaviour is purely per-process and
  // identical to a breaker with no shared state at all.
  private store: BreakerStore | undefined
  private readonly syncIntervalMs: number
  private lastSyncAt = 0

  constructor(
    private readonly label: string,
    private readonly threshold = 5,
    private readonly resetAfterMs = 30_000,
    opts: { store?: BreakerStore; syncIntervalMs?: number } = {}
  ) {
    this.store = opts.store
    this.syncIntervalMs = opts.syncIntervalMs ?? 1_000
  }

  // Attach (or replace) the shared store after construction — used to wire the
  // singleton breakers to Redis at startup once the connection exists.
  setStore(store: BreakerStore | undefined): void {
    this.store = store
  }

  // Throttled, fail-open read of the shared open-state. Lets a CLOSED breaker
  // discover that a sibling has already opened this circuit.
  private async syncFromStore(): Promise<void> {
    if (!this.store) return
    const now = Date.now()
    if (now - this.lastSyncAt < this.syncIntervalMs) return
    this.lastSyncAt = now
    let openUntil = 0
    try {
      openUntil = await this.store.getOpenUntil(this.label)
    } catch {
      return // fail-open: a store error must never block calls
    }
    if (openUntil > now && this.state === 'CLOSED') {
      console.warn(`[circuit:${this.label}] adopting OPEN from shared store (sibling tripped it)`)
      this.state = 'OPEN'
      // Align local timing so OPEN→HALF_OPEN happens when the shared window ends.
      this.lastFailureAt = openUntil - this.resetAfterMs
    }
  }

  private publishOpen(): void {
    if (!this.store) return
    void this.store.setOpenUntil(this.label, Date.now() + this.resetAfterMs).catch(() => {})
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.syncFromStore()

    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureAt >= this.resetAfterMs) {
        this.state = 'HALF_OPEN'
        console.warn(`[circuit:${this.label}] probing after ${this.resetAfterMs / 1000}s`)
      } else {
        throw new CircuitOpenError(this.label, this.resetAfterMs)
      }
    }

    // In HALF_OPEN, admit exactly one probe; reject everyone else until it
    // resolves so we don't slam a provider that may still be down.
    if (this.state === 'HALF_OPEN') {
      if (this.probing) {
        throw new CircuitOpenError(this.label, this.resetAfterMs)
      }
      this.probing = true
    }

    try {
      const result = await fn()
      if (this.state !== 'CLOSED') {
        console.log(`[circuit:${this.label}] recovered`)
        this.failures = 0
        this.state = 'CLOSED'
      }
      return result
    } catch (err) {
      this.failures++
      this.lastFailureAt = Date.now()
      if (this.failures >= this.threshold) {
        console.error(`[circuit:${this.label}] OPEN after ${this.failures} failures`)
        this.state = 'OPEN'
        // Broadcast the trip so sibling processes can adopt OPEN too.
        this.publishOpen()
      }
      throw err
    } finally {
      this.probing = false
    }
  }

  get isOpen() { return this.state === 'OPEN' }
  get status() { return this.state }
}

// Wire a shared store onto every singleton breaker. Called once at startup (api
// and worker) when a Redis connection is available; no-op-safe to omit.
export function attachBreakerStore(store: BreakerStore): void {
  for (const b of [openAiBreaker, apolloBreaker, apolloSearchBreaker, googlePlacesBreaker, stripeBreaker]) {
    b.setStore(store)
  }
}

// Singleton breakers — shared across requests in the same process
export const openAiBreaker      = new CircuitBreaker('openai',         5, 30_000)
export const apolloBreaker      = new CircuitBreaker('apollo-enrich',  5, 60_000)
export const apolloSearchBreaker = new CircuitBreaker('apollo-search', 5, 60_000)
export const googlePlacesBreaker = new CircuitBreaker('google-places', 5, 60_000)
export const stripeBreaker      = new CircuitBreaker('stripe',         5, 30_000)
