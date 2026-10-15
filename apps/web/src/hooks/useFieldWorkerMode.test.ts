import { describe, test, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useFieldWorkerMode, shouldLandOnMyJobs } from './useFieldWorkerMode.js'
import type { Workspace } from '../types.js'

const ws = (role: Workspace['role'], id = 'ws1'): Workspace => ({ id, name: 'N', slug: 'n', plan: 'free', role })
type Api = Parameters<typeof useFieldWorkerMode>[0]
const apiReturning = (linked: boolean) => vi.fn(async () => ({ linked, jobs: [] })) as unknown as Api & ReturnType<typeof vi.fn>

beforeEach(() => { window.localStorage.clear() })

describe('useFieldWorkerMode', () => {
  test('a member linked to a crew record is a field worker', async () => {
    const api = apiReturning(true)
    const { result } = renderHook(() => useFieldWorkerMode(api, ws('member')))
    expect(result.current.resolved).toBe(false)
    await waitFor(() => expect(result.current.resolved).toBe(true))
    expect(result.current).toMatchObject({ eligible: true, fieldWorker: true })
    expect(api).toHaveBeenCalledWith('/api/ops/technician/assigned?workspaceId=ws1')
  })

  test('a member with no crew link keeps the normal menu', async () => {
    const { result } = renderHook(() => useFieldWorkerMode(apiReturning(false), ws('member')))
    await waitFor(() => expect(result.current.resolved).toBe(true))
    expect(result.current).toMatchObject({ eligible: false, fieldWorker: false })
  })

  test('owners and admins are never field workers and cost no request', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const api = apiReturning(true)
      const { result } = renderHook(() => useFieldWorkerMode(api, ws(role)))
      await waitFor(() => expect(result.current.resolved).toBe(true))
      expect(result.current).toMatchObject({ eligible: false, fieldWorker: false })
      expect(api).not.toHaveBeenCalled()
    }
  })

  test('a failed lookup fails open to the normal menu', async () => {
    const api = vi.fn(async () => { throw new Error('offline') }) as unknown as Api
    const { result } = renderHook(() => useFieldWorkerMode(api, ws('member')))
    await waitFor(() => expect(result.current.resolved).toBe(true))
    expect(result.current).toMatchObject({ eligible: false, fieldWorker: false })
  })

  test('nothing resolves until a workspace is known', () => {
    const { result } = renderHook(() => useFieldWorkerMode(apiReturning(true), null))
    expect(result.current).toMatchObject({ resolved: false, fieldWorker: false })
  })

  test('opting into the full menu persists per workspace and keeps the user eligible to switch back', async () => {
    const { result, unmount } = renderHook(() => useFieldWorkerMode(apiReturning(true), ws('member')))
    await waitFor(() => expect(result.current.fieldWorker).toBe(true))
    act(() => result.current.setFullMenu(true))
    expect(result.current).toMatchObject({ eligible: true, fieldWorker: false })
    expect(window.localStorage.getItem('acaos.fullMenu.ws1')).toBe('1')
    unmount()
    const again = renderHook(() => useFieldWorkerMode(apiReturning(true), ws('member')))
    await waitFor(() => expect(again.result.current.resolved).toBe(true))
    expect(again.result.current).toMatchObject({ eligible: true, fieldWorker: false })
    act(() => again.result.current.setFullMenu(false))
    expect(again.result.current.fieldWorker).toBe(true)
    expect(window.localStorage.getItem('acaos.fullMenu.ws1')).toBeNull()
    // Another workspace is unaffected by ws1's choice.
    window.localStorage.setItem('acaos.fullMenu.ws1', '1')
    const other = renderHook(() => useFieldWorkerMode(apiReturning(true), ws('member', 'ws2')))
    await waitFor(() => expect(other.result.current.fieldWorker).toBe(true))
  })
})

describe('shouldLandOnMyJobs', () => {
  test('only for field workers arriving at the default route', () => {
    expect(shouldLandOnMyJobs({ fieldWorker: true, pathname: '/' })).toBe(true)
    expect(shouldLandOnMyJobs({ fieldWorker: true, pathname: '/leads' })).toBe(false)
    expect(shouldLandOnMyJobs({ fieldWorker: true, pathname: '/ops/technician' })).toBe(false)
    expect(shouldLandOnMyJobs({ fieldWorker: false, pathname: '/' })).toBe(false)
  })
})
