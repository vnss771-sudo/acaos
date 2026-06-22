// Unified client for every outbound third-party HTTP call (Apollo, Hunter,
// Google Places, …). It makes provider failure *boring and visible*: a bounded
// timeout, bounded retries with exponential backoff on transient statuses, an
// optional circuit breaker, a per-call metric, and a typed error taxonomy so a
// caller (and an operator) can always tell a provider fault apart from a
// legitimate empty result. Before this, e.g. Hunter swallowed every error into
// `null`, making "provider down" indistinguishable from "no contact found".
import { ApiError } from './errors.js'
import { fetchWithTimeout, FetchTimeoutError } from './fetchWithTimeout.js'
import { CircuitOpenError } from './circuit.js'
import { recordProviderCall as incProviderCall } from './observability.js'

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'network'
  | 'circuit_open'

// success is the non-error outcome; the rest mirror ProviderErrorKind so a single
// metric label space (provider_calls_total{outcome=...}) covers every result.
export type ProviderOutcome = 'success' | ProviderErrorKind

// Transient kinds are worth retrying and worth tripping a breaker on; a
// client_error (a 4xx that isn't 429) will not heal on retry.
const TRANSIENT: ReadonlySet<ProviderErrorKind> = new Set(['timeout', 'rate_limited', 'server_error', 'network'])
const DEFAULT_RETRY_ON = [408, 429, 500, 502, 503, 504]

// Typed provider failure. Extends ApiError so the Express error handler maps it to
// a sensible status (503 for transient/circuit, 502 for a bad client response)
// instead of an opaque 500, and so callers can branch on `instanceof ProviderError`.
export class ProviderError extends ApiError {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly kind: ProviderErrorKind,
    readonly providerStatus: number | null,
    message: string,
  ) {
    super(kind === 'client_error' ? 502 : 503, message)
    this.name = 'ProviderError'
  }

  get retryable(): boolean {
    return TRANSIENT.has(this.kind)
  }
}

// Structural shape of a CircuitBreaker — kept structural so tests can pass a fake.
export interface BreakerLike {
  call<R>(fn: () => Promise<R>): Promise<R>
}

export interface CallProviderOptions<T> {
  provider: string
  operation: string
  url: string | URL
  init?: RequestInit
  timeoutMs?: number
  /** Number of retries AFTER the first attempt (default 2 → up to 3 attempts). */
  retries?: number
  /** HTTP statuses that should be retried with backoff. */
  retryOnStatus?: number[]
  /** Base backoff in ms; attempt i waits baseBackoffMs * 2^i. */
  baseBackoffMs?: number
  breaker?: BreakerLike
  /** Map a successful (2xx) response to the result. */
  onSuccess: (res: Response) => Promise<T> | T
  /**
   * Map a terminal client error (a non-429 4xx) to a legitimate value — e.g. a
   * 404 from Hunter is "no contact found" (null), not a fault. If omitted, a
   * terminal client error throws a ProviderError like any other failure.
   */
  onClientError?: (res: Response) => Promise<T> | T
  // ── Test seams (no network / no real waiting) ────────────────────────────────
  fetchImpl?: (url: string | URL, init: RequestInit, timeoutMs: number) => Promise<Response>
  sleepImpl?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function classifyStatus(status: number): Exclude<ProviderErrorKind, 'timeout' | 'network' | 'circuit_open'> {
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'client_error'
}

export async function callProvider<T>(opts: CallProviderOptions<T>): Promise<T> {
  const run = () => attempt(opts)
  try {
    return opts.breaker ? await opts.breaker.call(run) : await run()
  } catch (err) {
    // A breaker that is already OPEN short-circuits before `run` — surface that
    // as its own outcome so dashboards can see "we never even called the provider".
    if (err instanceof CircuitOpenError) {
      incProviderCall(opts.provider, opts.operation, 'circuit_open')
      throw new ProviderError(opts.provider, opts.operation, 'circuit_open', null, err.message)
    }
    throw err // ProviderError (already metered in attempt) or an unexpected throw
  }
}

async function attempt<T>(opts: CallProviderOptions<T>): Promise<T> {
  const { provider, operation } = opts
  const retries = opts.retries ?? 2
  const retryOn = opts.retryOnStatus ?? DEFAULT_RETRY_ON
  const baseBackoffMs = opts.baseBackoffMs ?? 200
  const doFetch = opts.fetchImpl ?? fetchWithTimeout
  const sleep = opts.sleepImpl ?? realSleep

  const record = (outcome: ProviderOutcome) => incProviderCall(provider, operation, outcome)
  const backoff = (i: number) => sleep(baseBackoffMs * 2 ** i)

  let lastError: ProviderError | undefined

  for (let i = 0; i <= retries; i++) {
    let res: Response
    try {
      res = await doFetch(opts.url, opts.init ?? {}, opts.timeoutMs ?? 12_000)
    } catch (err) {
      const kind: ProviderErrorKind = err instanceof FetchTimeoutError ? 'timeout' : 'network'
      lastError = new ProviderError(provider, operation, kind, null, `${provider} ${operation}: ${(err as Error).message}`)
      if (i < retries) {
        await backoff(i)
        continue
      }
      record(kind)
      throw lastError
    }

    if (res.ok) {
      record('success')
      return await opts.onSuccess(res)
    }

    // Retry transient statuses with backoff before giving up.
    if (retryOn.includes(res.status) && i < retries) {
      await backoff(i)
      continue
    }

    const kind = classifyStatus(res.status)
    if (kind === 'client_error' && opts.onClientError) {
      // A terminal client error the caller treats as a legitimate empty result.
      // Still metered as client_error so the rate stays visible to operators.
      record('client_error')
      return await opts.onClientError(res)
    }
    record(kind)
    const detail = await res.text().catch(() => res.statusText)
    throw new ProviderError(provider, operation, kind, res.status, `${provider} ${operation} ${res.status}: ${detail.slice(0, 200)}`)
  }

  // Unreachable: the loop either returns or throws on its final iteration.
  throw lastError ?? new ProviderError(provider, operation, 'network', null, `${provider} ${operation}: exhausted retries`)
}
