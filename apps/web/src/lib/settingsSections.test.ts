import { describe, test, expect, vi, afterEach } from 'vitest'
import { scrollToSettingsSection, SETTINGS_SECTIONS } from './settingsSections'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('scrollToSettingsSection', () => {
  test('scrolls once the section mounts, polling until then', () => {
    vi.useFakeTimers()
    const scrollIntoView = vi.fn()
    scrollToSettingsSection('apiKeys')
    vi.advanceTimersByTime(100)
    const el = document.createElement('div')
    el.id = SETTINGS_SECTIONS.apiKeys
    el.scrollIntoView = scrollIntoView
    document.body.appendChild(el)
    vi.advanceTimersByTime(50)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  test('a pending poll stops quietly once the document is gone', () => {
    vi.useFakeTimers()
    scrollToSettingsSection('apiKeys')
    vi.stubGlobal('document', undefined)
    expect(() => vi.advanceTimersByTime(50 * 41)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
