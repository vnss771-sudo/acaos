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

  test('omits the Authorization header when there is no token', async () => {
    const fetchMock = mockFetch(200, {})
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useApi(null, () => {}))
    await result.current('/api/health')
    const [, init] = (fetchMock as any).mock.calls[0]
    expect((init.headers as Headers).has('Authorization')).toBe(false)
  })
})
