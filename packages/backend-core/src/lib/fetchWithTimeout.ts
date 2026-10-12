// A `fetch` wrapper that imposes a hard request deadline. Bare `fetch()` has no
// default timeout, so a hung provider socket can tie up a request/worker slot
// indefinitely — and the circuit breaker never sees a failure to trip on because
// the wrapped call simply never returns. Every outbound call to a third-party
// HTTP API must go through this.

const DEFAULT_TIMEOUT_MS = 12_000

/**
 * Origin + path only. Some providers (e.g. PlanningAlerts) take their API key as a
 * `?key=` query parameter, and error messages are persisted and shown to tenants,
 * so the query string and any userinfo must never reach one.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0] ?? ''
  }
}

const SECRET_PARAM_RE = /([?&;](?:api[_-]?key|key|token|secret|access[_-]?token|auth|password|sig|signature)=)[^&\s"'<>)]*/gi

/** Mask credential-bearing query parameters in any free text (errors, logs, stored diagnostics). */
export function scrubSecrets(text: string): string {
  return text.replace(SECRET_PARAM_RE, '$1[redacted]')
}

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${redactUrl(url)} timed out after ${timeoutMs}ms`)
    this.name = 'FetchTimeoutError'
  }
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    // Normalize an abort into a typed, descriptive error so callers/breakers can
    // treat a timeout like any other transient provider failure.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchTimeoutError(String(input), timeoutMs)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
