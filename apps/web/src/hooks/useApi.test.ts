import { describe, test, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useApi } from './useApi.js'

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('useApi', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  test('attaches a Bearer token and JSON content-type for body requests', async () => {
    const fetchMock = mockFetch(200, { ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useApi('tok-123', () => {}))

    await result.current('/api/leads', { method: 'POST', body: JSON.stringify({ x: 1 }) })

    const [, init] = (fetchMock as any).mock.calls[0]
    const headers = init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer tok-123')
    expect(headers.get('Content-Type')).toBe('application/json')
    // credentials must be included so the HttpOnly refresh cookie travels.
    expect(init.credentials).toBe('include')
  })

  test('on 401 it refreshes via the cookie endpoint and retries with the new token', async () => {
    // First call → 401; refresh → new token; retry → success.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({ error: 'expired' }) })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ token: 'fresh-tok' }) })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ lead: { id: 'l9' } }) })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const onRefresh = vi.fn()
    const { result } = renderHook(() => useApi('stale', () => {}, onRefresh))
    const data = await result.current<{ lead: { id: string } }>('/api/leads/l9')
    expect(data.lead.id).toBe('l9')

    // The refresh call hits the auth endpoint with credentials + CSRF header and no body.
    const [refreshUrl, refreshInit] = (fetchMock as any).mock.calls[1]
    expect(refreshUrl).toMatch(/\/api\/auth\/refresh$/)
    expect(refreshInit.credentials).toBe('include')
    expect((refreshInit.headers as Record<string, string>)['X-CSRF-Protection']).toBe('1')
    expect(refreshInit.body).toBeUndefined()
    // The retry used the fresh access token.
    expect(onRefresh).toHaveBeenCalledWith('fresh-tok')
    const [, retryInit] = (fetchMock as any).mock.calls[2]
    expect((retryInit.headers as Headers).get('Authorization')).toBe('Bearer fresh-tok')
  })

  test('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { lead: { id: 'l1' } }))
    const { result } = renderHook(() => useApi('t', () => {}))
    const data = await result.current<{ lead: { id: string } }>('/api/leads/l1')
    expect(data.lead.id).toBe('l1')
  })

  test('calls onUnauth and throws on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'nope' }))
    const onUnauth = vi.fn()
    const { result } = renderHook(() => useApi('t', onUnauth))
    await expect(result.current('/api/me')).rejects.toThrow(/Session expired/)
    expect(onUnauth).toHaveBeenCalledOnce()
  })

  test('throws the server error message on non-OK responses', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { error: 'businessName required' }))
    const { result } = renderHook(() => useApi('t', () => {}))
    await expect(result.current('/api/leads', { method: 'POST', body: '{}' }))
      .rejects.toThrow('businessName required')
  })

  test('aborts and throws a timeout error when a request exceeds timeoutMs', async () => {
    // A fetch that never resolves until its abort signal fires.
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const { result } = renderHook(() => useApi('t', () => {}))
    await expect(result.current('/api/slow', { timeoutMs: 10 })).rejects.toThrow(/timed out/i)
  })

  test('omits the Authorization header when there is no token', async () => {
    const fetchMock = mockFetch(200, {})
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useApi(null, () => {}))
    await result.current('/api/health')
    const [, init] = (fetchMock as any).mock.calls[0]
    expect((init.headers as Headers).has('Authorization')).toBe(false)
  })
})

describe('tryRefresh — one refresh at a time', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  test('concurrent callers in one tab share a single round-trip (a second would look like token theft)', async () => {
    const { tryRefresh } = await import('./useApi.js')
    let release: (v: unknown) => void = () => {}
    const fetchMock = vi.fn(() => new Promise(r => { release = r }).then(() => ({ status: 200, ok: true, json: async () => ({ token: 'fresh' }) })))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const a = tryRefresh()
    const b = tryRefresh()
    await Promise.resolve()
    release(null)
    expect(await Promise.all([a, b])).toEqual(['fresh', 'fresh'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('the round-trip runs under a cross-tab Web Lock when the browser has one', async () => {
    const { tryRefresh } = await import('./useApi.js')
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb())
    vi.stubGlobal('navigator', { ...navigator, locks: { request } })
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ token: 't2' }) })) as unknown as typeof fetch)
    expect(await tryRefresh()).toBe('t2')
    expect(request).toHaveBeenCalledWith('acaos-auth-refresh', expect.any(Function))
  })

  test('a failed refresh resolves to null so the caller shows sign-in', async () => {
    const { tryRefresh } = await import('./useApi.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })) as unknown as typeof fetch)
    expect(await tryRefresh()).toBeNull()
  })
})
