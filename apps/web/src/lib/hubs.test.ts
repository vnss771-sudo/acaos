import { describe, test, expect, afterEach } from 'vitest'
import { HUBS, hubForView, visibleTabs, defaultViewForHub, isHubNavEnabled } from './hubs.js'
import type { View } from '../types.js'

describe('hubs model', () => {
  test('exposes exactly the five consolidated hubs in order', () => {
    expect(HUBS.map(h => h.id)).toEqual(['home', 'prospects', 'outreach', 'inbox', 'settings'])
  })

  test('every legacy view id maps to exactly one hub', () => {
    const ALL_VIEWS: View[] = [
      'dashboard', 'intelligence', 'prospects', 'missions', 'campaigns',
      'approvals', 'inbox', 'leads', 'ai', 'billing', 'settings', 'admin',
    ]
    for (const v of ALL_VIEWS) {
      const owning = HUBS.filter(h => h.tabs.some(t => t.view === v))
      expect(owning, `view ${v} should belong to one hub`).toHaveLength(1)
    }
  })

  test('hubForView routes the merged pages to their hub', () => {
    expect(hubForView('leads').id).toBe('prospects')
    expect(hubForView('intelligence').id).toBe('prospects')
    expect(hubForView('approvals').id).toBe('outreach')
    expect(hubForView('ai').id).toBe('outreach')
    expect(hubForView('billing').id).toBe('settings')
    expect(hubForView('admin').id).toBe('settings')
  })

  test('inbox hub holds only the inbox (approvals live in outreach, not here)', () => {
    const inbox = HUBS.find(h => h.id === 'inbox')!
    expect(inbox.tabs.map(t => t.view)).toEqual(['inbox'])
    expect(hubForView('approvals').id).not.toBe('inbox')
  })

  test('visibleTabs hides the admin-only tab from non-admins', () => {
    const settings = HUBS.find(h => h.id === 'settings')!
    expect(visibleTabs(settings, false).map(t => t.view)).toEqual(['settings', 'billing'])
    expect(visibleTabs(settings, true).map(t => t.view)).toEqual(['settings', 'billing', 'admin'])
  })

  test('defaultViewForHub opens a hub at its first visible tab', () => {
    const prospects = HUBS.find(h => h.id === 'prospects')!
    expect(defaultViewForHub(prospects, false)).toBe('prospects')
    const settings = HUBS.find(h => h.id === 'settings')!
    expect(defaultViewForHub(settings, false)).toBe('settings')
  })
})

describe('isHubNavEnabled', () => {
  afterEach(() => { localStorage.clear() })

  test('defaults off when no override and no build flag', () => {
    expect(isHubNavEnabled()).toBe(false)
  })

  test('localStorage override turns it on', () => {
    localStorage.setItem('acaos_hub_nav', '1')
    expect(isHubNavEnabled()).toBe(true)
    localStorage.setItem('acaos_hub_nav', 'true')
    expect(isHubNavEnabled()).toBe(true)
  })

  test('localStorage override can force it off', () => {
    localStorage.setItem('acaos_hub_nav', '0')
    expect(isHubNavEnabled()).toBe(false)
  })
})
