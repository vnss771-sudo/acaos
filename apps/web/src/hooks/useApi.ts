import { useCallback } from 'react'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export type ApiOptions = RequestInit & { skipContentType?: boolean }

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
      const data = await res.json().catch(() => ({}))

      if (res.status === 401) {
        onUnauth()
        throw new Error('Session expired. Please log in again.')
      }
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`)
      }
      return data as T
    },
    [token, onUnauth]
  )
}

export type ApiHook = ReturnType<typeof useApi>
