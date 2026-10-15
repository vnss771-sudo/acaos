import { describe, it, expect, vi, afterEach } from 'vitest'
import { attachBrowserEvents, webLock, createUploader, purgeAllQueuedPhotos } from './createUploader'
import { MemoryQueueStore } from './queueStore'
import { item } from './queueStoreContract'
import type { EvidenceApi } from './uploadEngine'

afterEach(() => { vi.unstubAllGlobals() })

describe('attachBrowserEvents (foreground and connectivity resume)', () => {
  it('kicks on online, focus, pageshow and when the page becomes visible; not when hidden; stops after detach', () => {
    const kick = vi.fn()
    const detach = attachBrowserEvents(kick)
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow'))
    expect(kick).toHaveBeenCalledTimes(3)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(kick).toHaveBeenCalledTimes(3)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(kick).toHaveBeenCalledTimes(4)
    detach()
    window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange'))
    expect(kick).toHaveBeenCalledTimes(4)
  })
})

describe('webLock', () => {
  it('runs the work without the Locks API (server idempotency still prevents duplicates)', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    expect(await webLock('x', async () => 7)).toEqual({ ran: true, value: 7 })
  })
  it('reports "not run" when another tab holds the lock, and runs when it is free', async () => {
    const request = vi.fn(async (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => cb(null))
    vi.stubGlobal('navigator', { locks: { request } })
    const fn = vi.fn(async () => 1)
    expect(await webLock('x', fn)).toEqual({ ran: false })
    expect(fn).not.toHaveBeenCalled()
    expect(request.mock.calls[0][1]).toEqual({ ifAvailable: true })
    request.mockImplementation(async (_n, _o, cb) => cb({}))
    expect(await webLock('x', fn)).toEqual({ ran: true, value: 1 })
  })
})

describe('createUploader / purgeAllQueuedPhotos', () => {
  const api: EvidenceApi = { init: vi.fn(), complete: vi.fn(), status: vi.fn(), cancel: vi.fn() } as unknown as EvidenceApi
  it('builds an engine bound to one user and workspace', async () => {
    const store = new MemoryQueueStore()
    const engine = createUploader({ scope: { userId: 'u', workspaceId: 'w' }, api, sessionUserId: () => 'u', store })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await engine.start()
    expect(engine.getSnapshot().items).toEqual([])
    engine.dispose()
  })
  it('wipes every queued photo for every account (sign-out)', async () => {
    const store = new MemoryQueueStore()
    const a = { userId: 'a', workspaceId: 'w1' }, b = { userId: 'b', workspaceId: 'w2' }
    await store.add(a, item(a, '1'), { limits: { maxQueueItems: 5, maxQueueBytes: 1e6 } })
    await store.add(b, item(b, '2'), { limits: { maxQueueItems: 5, maxQueueBytes: 1e6 } })
    await purgeAllQueuedPhotos(store)
    expect(await store.list(a)).toEqual([])
    expect(await store.list(b)).toEqual([])
  })
})
