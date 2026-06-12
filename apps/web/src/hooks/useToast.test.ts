import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToast } from './useToast.js'

describe('useToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('adds a toast with the given type', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.toast.success('Saved') })
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0]).toMatchObject({ message: 'Saved', type: 'success' })
  })

  test('auto-dismisses a toast after its duration', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.toast.info('hi') }) // default 4000ms
    expect(result.current.toasts).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current.toasts).toHaveLength(0)
  })

  test('error toasts persist longer than info toasts', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.toast.error('boom') }) // 6000ms
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current.toasts).toHaveLength(1) // still there
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current.toasts).toHaveLength(0)
  })

  test('removeToast removes a specific toast by id', () => {
    const { result } = renderHook(() => useToast())
    let id = ''
    act(() => { id = result.current.toast.success('a'); result.current.toast.error('b') })
    expect(result.current.toasts).toHaveLength(2)
    act(() => { result.current.removeToast(id) })
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0].message).toBe('b')
  })
})
