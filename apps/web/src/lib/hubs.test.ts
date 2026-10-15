import { describe, test, expect, afterEach } from 'vitest'
import { HUBS, hubForView, visibleTabs, defaultViewForHub, isHubNavEnabled, hubsFor, FIELD_WORKER_VIEWS } from './hubs.js'
import type { View } from '../types.js'

describe('hubs model', () => {
  test('exposes the contractor-first hubs in loop order', () => {
    expect(HUBS.map(h => h.id)).toEqual(['today', 'work', 'crew', 'outreach', 'settings'])
  })

  test('every view id maps to exactly one hub', () => {
    const ALL_VIEWS: View[] = [
      'today', 'dashboard', 'intelligence', 'prospects', 'missions', 'campaigns',
      'approvals', 'inbox', 'leads', 'ai', 'billing', 'settings', 'admin',
      'ops-dashboard', 'ops-crew', 'ops-jobs', 'ops-shifts', 'ops-roster', 'ops-fatigue', 'ops-alerts',
      'ops-find-work', 'ops-delivery', 'ops-scorecard', 'ops-technician',
    ]
    for (const v of ALL_VIEWS) {
      const owning = HUBS.filter(h => h.tabs.some(t => t.view === v))
      expect(owning, `view ${v} should belong to one hub`).toHaveLength(1)
    }
  })

  test('the contractor loop reads in order: find work, clients, jobs, scorecard; then the crew pages', () => {
    expect(HUBS.find(h => h.id === 'work')!.tabs.map(t => t.view)).toEqual(['ops-find-work', 'prospects', 'ops-delivery', 'ops-scorecard'])
    expect(hubForView('ops-shifts').id).toBe('crew')
    expect(hubForView('ops-delivery').id).toBe('work')
    expect(hubForView('inbox').id).toBe('outreach')
    expect(hubForView('billing').id).toBe('settings')
    expect(hubForView('admin').id).toBe('settings')
  })

  test('visibleTabs hides the admin-only tab from non-admins', () => {
    const settings = HUBS.find(h => h.id === 'settings')!
    expect(visibleTabs(settings, false).map(t => t.view)).toEqual(['settings', 'billing'])
    expect(visibleTabs(settings, true).map(t => t.view)).toEqual(['settings', 'billing', 'admin'])
  })

  test('defaultViewForHub opens a hub at its first visible tab', () => {
    const work = HUBS.find(h => h.id === 'work')!
    expect(defaultViewForHub(work, false)).toBe('ops-find-work')
    const settings = HUBS.find(h => h.id === 'settings')!
    expect(defaultViewForHub(settings, false)).toBe('settings')
  })
})

describe('isHubNavEnabled', () => {
  afterEach(() => { localStorage.clear() })

  test('defaults on when no override and no build flag', () => {
    expect(isHubNavEnabled()).toBe(true)
  })

  test('localStorage override turns it on explicitly', () => {
    localStorage.setItem('acaos_hub_nav', '1')
    expect(isHubNavEnabled()).toBe(true)
    localStorage.setItem('acaos_hub_nav', 'true')
    expect(isHubNavEnabled()).toBe(true)
  })

  test('localStorage override can force it off (rollback path)', () => {
    localStorage.setItem('acaos_hub_nav', '0')
    expect(isHubNavEnabled()).toBe(false)
    localStorage.setItem('acaos_hub_nav', 'false')
    expect(isHubNavEnabled()).toBe(false)
  })
})

describe('field-worker hubs', () => {
  test('the normal menu is unchanged', () => {
    expect(hubsFor(false)).toBe(HUBS)
    expect(hubForView('ops-technician').id).toBe('crew')
  })

  test('a field worker gets one reduced hub with only their own functions', () => {
    const hubs = hubsFor(true)
    expect(hubs).toHaveLength(1)
    expect(hubs[0].label).toBe('My work')
    expect(hubs[0].tabs.map(t => t.view)).toEqual(['ops-technician', 'ops-shifts'])
    expect(hubs[0].tabs.map(t => t.view).sort()).toEqual([...FIELD_WORKER_VIEWS].sort())
    // Management pages are not advertised.
    for (const hidden of ['ops-crew', 'ops-roster', 'ops-alerts', 'campaigns', 'billing', 'ops-delivery'] as const) {
      expect(hubs[0].tabs.some(t => t.view === hidden)).toBe(false)
    }
    expect(defaultViewForHub(hubs[0], false)).toBe('ops-technician')
  })

  test('any other view resolves to the reduced hub rather than an empty nav', () => {
    expect(hubForView('leads', true).label).toBe('My work')
    expect(hubForView('ops-technician', true).label).toBe('My work')
  })
})

