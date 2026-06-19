// Shared HTTP client for outbound third-party provider calls (Apollo, Hunter,
// Google Places, …). Every provider request must go through here so that bounded
// timeouts, transient-failure retries, response-size limits, optional circuit
// breaking, and structured telemetry are applied uniformly — a hung or
// misbehaving provider can no longer pin an API request or worker job.
//
// Contract:
// - Returns the `Response` for any HTTP status (including non-2xx). Callers keep
//   their existing `if (!res.ok)` handling — this client does NOT turn a 4xx/5xx
//   body into a thrown error (it only retries transient statuses, then returns
//   the final response). This keeps the refactor behaviour-preserving.
// - Throws `ProviderHttpError` only for: a timeout/abort, a network error that
//   survives all retries, or a response that exceeds `maxBytes`.
// - When a `breaker` is supplied, a tripped breaker throws `CircuitOpenError`
//   (propagated unchanged so existing `instanceof CircuitOpenError` checks work).

import { CircuitBreaker } from './circuit.js'
import { logger } from './logger.js'

export type ProviderFetchOptions = {
  /** Short provider label for logs/metrics, e.g. 'apollo-enrich', 'hunter'. */
  provider: string
  /**
   * Per-attempt timeout. Precedence: explicit `timeoutMs` →
   * `${envPrefix}_TIMEOUT_MS` → `EXTERNAL_HTTP_TIMEOUT_MS` → 12s.
   */
  timeoutMs?: number
  /**
   * Extra attempts after the first (so 2 ⇒ up to 3 attempts). Precedence:
   * explicit `retries` → `${envPrefix}_RETRIES` → `EXTERNAL_HTTP_RETRIES` → 2.
   */
  retries?: number
  /**
   * Env-var namespace for per-provider timeout/retry overrides, e.g. 'APOLLO'
   * reads `APOLLO_TIMEOUT_MS` / `APOLLO_RETRIES`. Falls back to the global
   * `EXTERNAL_HTTP_*` knobs, then the built-in defaults.
   */
  envPrefix?: string
  /** Reject responses whose Content-Length exceeds this. Default 5 MB. */
  maxBytes?: number
  /** Optional circuit breaker wrapping the whole call. */
  breaker?: CircuitBreaker
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly kind: 'timeout' | 'network' | 'oversize',
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_RETRIES = 2
const DEFAULT_MAX_BYTES = 5_000_000

// Transient HTTP statuses worth retrying. 4xx other than these are caller errors
// and are returned immediately.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Reads a non-negative finite number from an env var, or undefined if unset/invalid. */
function numEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function resolveTimeoutMs(opts: ProviderFetchOptions): number {
  if (opts.timeoutMs != null) return opts.timeoutMs
  const prefixed = opts.envPrefix ? numEnv(`${opts.envPrefix}_TIMEOUT_MS`) : undefined
  return prefixed ?? numEnv('EXTERNAL_HTTP_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS
}

function resolveRetries(opts: ProviderFetchOptions): number {
  if (opts.retries != null) return opts.retries
  const prefixed = opts.envPrefix ? numEnv(`${opts.envPrefix}_RETRIES`) : undefined
  return Math.floor(prefixed ?? numEnv('EXTERNAL_HTTP_RETRIES') ?? DEFAULT_RETRIES)
}

function backoffMs(attempt: number): number {
  // attempt is 0-based for the first retry: 250ms, 500ms, 1000ms … capped at 2s.
  return Math.min(250 * 2 ** attempt, 2_000)
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, 5_000)
  return null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function enforceMaxBytes(res: Response, provider: string, maxBytes: number): void {
  // Defensive `?.`: real fetch Responses always carry headers, but it keeps the
  // client robust if a caller passes a minimal Response-like object.
  const len = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(len) && len > maxBytes) {
    throw new ProviderHttpError(
      `${provider} response too large: ${len} bytes (max ${maxBytes})`,
      provider,
      'oversize',
    )
  }
}

async function runWithRetries(url: string, init: RequestInit, opts: ProviderFetchOptions): Promise<Response> {
  const provider = opts.provider
  const timeoutMs = resolveTimeoutMs(opts)
  const retries = resolveRetries(opts)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const parentSignal = init.signal ?? undefined

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Honour caller cancellation before spending another attempt/backoff.
    if (parentSignal?.aborted) {
      throw new ProviderHttpError(`${provider} request aborted by caller`, provider, 'network', parentSignal.reason)
    }
    const startedAt = Date.now()
    // Clearable, unref'd timeout so a hung socket is aborted without the timer
    // itself keeping the process/event loop alive. A caller-supplied signal is
    // propagated so request cancellation still aborts the in-flight fetch.
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(parentSignal?.reason)
    if (parentSignal) parentSignal.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(Object.assign(new Error(`${provider} timed out after ${timeoutMs}ms`), { name: 'TimeoutError' })),
      timeoutMs,
    )
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const latencyMs = Date.now() - startedAt

      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const wait = retryAfterMs(res) ?? backoffMs(attempt)
        logger.warn('provider.http.retry', { provider, status: res.status, attempt, latencyMs, waitMs: wait })
        await sleep(wait)
        continue
      }

      enforceMaxBytes(res, provider, maxBytes)
      logger.info('provider.http', { provider, status: res.status, attempt, latencyMs })
      return res
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      // Oversize is a hard, non-retryable failure surfaced to the caller.
      if (err instanceof ProviderHttpError) throw err
      lastErr = err
      const timedOut = isAbortError(err)
      logger.warn('provider.http.error', {
        provider, attempt, latencyMs, timeout: timedOut, err: (err as Error)?.message,
      })
      if (attempt < retries) {
        await sleep(backoffMs(attempt))
        continue
      }
      const kind = timedOut ? 'timeout' : 'network'
      const detail = timedOut ? `timed out after ${timeoutMs}ms` : ((err as Error)?.message ?? 'network error')
      throw new ProviderHttpError(`${provider} request failed: ${detail}`, provider, kind, err)
    } finally {
      clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort)
    }
  }
  // Unreachable, but satisfies the type checker.
  throw new ProviderHttpError(`${provider} request failed`, provider, 'network', lastErr)
}

/**
 * Fetch an external provider endpoint with bounded timeout, transient retries,
 * response-size limit, optional circuit breaking, and structured telemetry.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  opts: ProviderFetchOptions,
): Promise<Response> {
  if (opts.breaker) {
    // The breaker counts a thrown ProviderHttpError (timeout/network) as a failure
    // and trips after its threshold; a returned non-2xx Response does NOT (the
    // call "succeeded" at the transport level). This matches the breakers'
    // existing semantics around the previous raw fetch calls.
    return opts.breaker.call(() => runWithRetries(url, init, opts))
  }
  return runWithRetries(url, init, opts)
}
