import { useCallback } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export type ApiOptions = RequestInit & { skipContentType?: boolean }

async function tryRefresh(): Promise<string | null> {
  // The refresh token lives in an HttpOnly cookie (sent automatically with
  // credentials: 'include'); JS never sees it. A custom header satisfies the
  // server's CSRF guard. The new access token comes back in the body.
  try {
    const res = await fetch(`${API}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Protection': '1' }
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.token as string
  } catch {
    return null
  }
}

export function useApi(token: string | null, onUnauth: () => void, onTokenRefresh?: (t: string) => void) {
  return useCallback(
    async <T = unknown>(path: string, init: ApiOptions = {}): Promise<T> => {
      const { skipContentType, ...fetchInit } = init
      const headers = new Headers(fetchInit.headers || {})

      if (!skipContentType && !headers.has('Content-Type') && fetchInit.body) {
        headers.set('Content-Type', 'application/json')
      }
      if (token) headers.set('Authorization', `Bearer ${token}`)

      // credentials: 'include' so the HttpOnly refresh cookie is sent to the
      // auth endpoints; harmless for the rest (they authenticate via the header).
      const res = await fetch(`${API}${path}`, { ...fetchInit, headers, credentials: 'include' })

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
          const retryRes = await fetch(`${API}${path}`, { ...fetchInit, headers: retryHeaders, credentials: 'include' })
          const retryData = await retryRes.json().catch(() => ({}))
          if (!retryRes.ok) {
            throw new Error(typeof retryData.error === 'string' ? retryData.error : `Request failed (${retryRes.status})`)
          }
          return retryData as T
        }
        onUnauth()
        throw new Error('Session expired. Please log in again.')
      }

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`)
      }
      return data as T
    },
    [token, onUnauth, onTokenRefresh]
  )
}

export type ApiHook = ReturnType<typeof useApi>
