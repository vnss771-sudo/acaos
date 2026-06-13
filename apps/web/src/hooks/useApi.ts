import { useCallback } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export type ApiOptions = RequestInit & { skipContentType?: boolean }

async function tryRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem('acaos_refresh')
  if (!refreshToken) return null
  try {
    const res = await fetch(`${API}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    })
    if (!res.ok) return null
    const data = await res.json()
    localStorage.setItem('acaos_token', data.token)
    if (data.refreshToken) localStorage.setItem('acaos_refresh', data.refreshToken)
    return data.token as string
  } catch {
    return null
  }
}

export function useApi(token: string | null, onUnauth: () => void) {
  return useCallback(
    async <T = unknown>(path: string, init: ApiOptions = {}): Promise<T> => {
      const { skipContentType, ...fetchInit } = init
      const headers = new Headers(fetchInit.headers || {})

      if (!skipContentType && !headers.has('Content-Type') && fetchInit.body) {
        headers.set('Content-Type', 'application/json')
      }
      if (token) headers.set('Authorization', `Bearer ${token}`)

      const res = await fetch(`${API}${path}`, { ...fetchInit, headers })

      if (res.status === 401) {
        const newToken = await tryRefresh()
        if (newToken) {
          const retryHeaders = new Headers(fetchInit.headers || {})
          if (!skipContentType && !retryHeaders.has('Content-Type') && fetchInit.body) {
            retryHeaders.set('Content-Type', 'application/json')
          }
          retryHeaders.set('Authorization', `Bearer ${newToken}`)
          const retryRes = await fetch(`${API}${path}`, { ...fetchInit, headers: retryHeaders })
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
    [token, onUnauth]
  )
}

export type ApiHook = ReturnType<typeof useApi>
