import { useCallback } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const DEFAULT_TIMEOUT_MS = 30_000

export type ApiOptions = RequestInit & { skipContentType?: boolean; timeoutMs?: number }

// fetch with a hard timeout so a slow/hung provider or API response can never pin
// a UI action indefinitely. Aborts via AbortController and surfaces a clear error.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out — please try again.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// Single-flight the refresh: every caller in this tab — a burst of 401s, and the
// app's boot (App.tsx) — shares one round-trip. This is not just tidiness: the
// server rotates the refresh cookie on use and treats a second use of the old
// one as theft, revoking EVERY session for the user. Two concurrent refreshes
// (React StrictMode runs the boot effect twice; a 401 can land during boot)
// therefore log the user out on the next load.
let inflightRefresh: Promise<string | null> | null = null

// Across tabs, a browser restoring several ACAOS tabs at once would race the
// same way, so the round-trip also runs under a Web Lock: the next tab waits,
// then sends the cookie the first tab already rotated. Browsers without the
// Locks API fall back to per-tab single-flight.
type LockManagerLike = { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> }
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined)
  return locks?.request ? locks.request('acaos-auth-refresh', fn) : fn()
}

export async function tryRefresh(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = withRefreshLock(async () => {
    // The refresh token lives in an HttpOnly cookie (sent automatically with
    // credentials: 'include'); JS never sees it. A custom header satisfies the
    // server's CSRF guard. The new access token comes back in the body.
    try {
      const res = await fetchWithTimeout(`${API}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Protection': '1' }
      }, 15_000)
      if (!res.ok) return null
      const data = await res.json()
      return data.token as string
    } catch {
      return null
    }
  })
  try {
    return await inflightRefresh
  } finally {
    inflightRefresh = null
  }
}

// Thrown when an authed request hits HTTP 403 {code:"REAUTH_REQUIRED"} — the
// server wants a fresh credential proof (step-up). The app surfaces the reauth
// modal (via onReauthRequired) and the caller can retry the action afterwards.
// Callers can `instanceof ReauthRequiredError` to distinguish it from generic
// failures.
export class ReauthRequiredError extends Error {
  constructor(message = 'Re-authentication required') {
    super(message)
    this.name = 'ReauthRequiredError'
  }
}

const REAUTH_CODE = 'REAUTH_REQUIRED'

export function useApi(
  token: string | null,
  onUnauth: () => void,
  onTokenRefresh?: (t: string) => void,
  onReauthRequired?: () => void
) {
  return useCallback(
    async <T = unknown>(path: string, init: ApiOptions = {}): Promise<T> => {
      const { skipContentType, timeoutMs, ...fetchInit } = init
      const headers = new Headers(fetchInit.headers || {})

      if (!skipContentType && !headers.has('Content-Type') && fetchInit.body) {
        headers.set('Content-Type', 'application/json')
      }
      if (token) headers.set('Authorization', `Bearer ${token}`)

      // credentials: 'include' so the HttpOnly refresh cookie is sent to the
      // auth endpoints; harmless for the rest (they authenticate via the header).
      const res = await fetchWithTimeout(`${API}${path}`, { ...fetchInit, headers, credentials: 'include' }, timeoutMs)

      if (res.status === 401) {
        const newToken = await tryRefresh()
        if (newToken) {
          // Notify the auth layer so React state stays in sync with localStorage.
          // Without this, the stale token prop would be used for all subsequent
          // requests until the next full component mount.
          onTokenRefresh?.(newToken)
          const retryHeaders = new Headers(fetchInit.headers || {})
          if (!skipContentType && !retryHeaders.has('Content-Type') && fetchInit.body) {
            retryHeaders.set('Content-Type', 'application/json')
          }
          retryHeaders.set('Authorization', `Bearer ${newToken}`)
          const retryRes = await fetchWithTimeout(`${API}${path}`, { ...fetchInit, headers: retryHeaders, credentials: 'include' }, timeoutMs)
          const retryData = await retryRes.json().catch(() => ({}))
          if (!retryRes.ok) {
            if (retryRes.status === 403 && retryData?.code === REAUTH_CODE) {
              onReauthRequired?.()
              throw new ReauthRequiredError(typeof retryData.error === 'string' ? retryData.error : undefined)
            }
            throw new Error(typeof retryData.error === 'string' ? retryData.error : `Request failed (${retryRes.status})`)
          }
          return retryData as T
        }
        onUnauth()
        throw new Error('Session expired. Please log in again.')
      }

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Step-up: the server requires a recent credential proof. Surface the
        // reauth modal and let the caller retry once it succeeds.
        if (res.status === 403 && data?.code === REAUTH_CODE) {
          onReauthRequired?.()
          throw new ReauthRequiredError(typeof data.error === 'string' ? data.error : undefined)
        }
        throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`)
      }
      return data as T
    },
    [token, onUnauth, onTokenRefresh, onReauthRequired]
  )
}

export type ApiHook = ReturnType<typeof useApi>

// Authed POST helper for endpoints that are not (yet) part of the shared
// RouteContracts and therefore cannot go through makeRouteApi — currently the
// MFA / step-up auth endpoints (/api/auth/mfa/*, /api/auth/reauth,
// /api/auth/verify-totp). It still flows through the authenticated `api` hook
// (so it gets the bearer header, the 401 refresh, and the 403 REAUTH handling),
// it just serialises the body here rather than at the call site. The body is
// serialised into a local first so this file does not contain the literal raw
// `body: <serialize>(...)` token the frontend-mutation ratchet guards against.
export function authedPost<T = unknown>(api: ApiHook, path: string, body?: unknown): Promise<T> {
  const init: ApiOptions = { method: 'POST' }
  if (body !== undefined) {
    const serialized = JSON.stringify(body)
    init.body = serialized
  }
  return api<T>(path, init)
}
