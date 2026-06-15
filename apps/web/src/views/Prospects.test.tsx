import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProspectsView } from './Prospects.js'
import type { Prospect, Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const prospect = {
  id: 'p1', companyName: 'Meridian Roofing', industry: 'Construction',
  opportunityScore: 84, intentScore: 80, fitScore: 75, timingScore: 70, confidenceScore: 65,
  buyingStage: 'PURCHASING', signals: [], recommendations: [],
} as unknown as Prospect

afterEach(() => vi.restoreAllMocks())

function makeApi(overrides?: (path: string) => unknown) {
  return vi.fn((path: string) => {
    if (overrides) {
      const result = overrides(path)
      if (result !== undefined) return result
    }
    if (path.includes('/sources')) return Promise.resolve({ sources: [] })
    return Promise.resolve({ prospects: [], total: 0 })
  })
}

describe('ProspectsView', () => {
  test('shows an empty state when no workspace is selected', () => {
    const api = makeApi()
    render(<ProspectsView api={api as never} workspace={null} toast={toast as never} />)
    expect(screen.getByText('No workspace selected')).toBeInTheDocument()
    // sources endpoint is fetched regardless of workspace; prospects endpoint is not
    expect(api).not.toHaveBeenCalledWith(expect.stringContaining('/api/prospects?workspaceId'))
  })

  test('fetches and renders prospects with their opportunity score', async () => {
    const api = makeApi((path) => {
      if (path.includes('/sources')) return Promise.resolve({ sources: [] })
      if (path.includes('/api/prospects?')) return Promise.resolve({ prospects: [prospect], total: 1 })
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument()
    expect(screen.getByText('84')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/prospects?workspaceId=ws1&limit=100')
  })

  test('shows the empty state when the workspace has no prospects', async () => {
    const api = makeApi()
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/No prospects yet/i)).toBeInTheDocument()
  })

  test('typing in search refetches with the search query', async () => {
    const api = makeApi()
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.type(screen.getByPlaceholderText('Search prospects…'), 'acme')
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining('search=acme')),
    )
  })

  test('scopes discovery to a chosen mission (passes missionId to /discover)', async () => {
    const api = makeApi((path) => {
      if (path.includes('/sources')) return Promise.resolve({ sources: [{ name: 'apollo', label: 'Apollo', isConfigured: true }] })
      if (path.includes('/api/missions')) return Promise.resolve({ missions: [{ id: 'm1', name: 'Q3 Push', status: 'ACTIVE' }] })
      if (path === '/api/prospects/discover') return Promise.resolve({ discovered: 2, skipped: 0, total: 2 })
      return undefined
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)

    // Pick the mission, then trigger discovery.
    const select = await screen.findByTitle('Attribute discovered prospects to a mission')
    await userEvent.selectOptions(select, 'm1')
    await userEvent.click(await screen.findByText('⚡ Apollo'))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/prospects/discover',
      expect.objectContaining({ body: JSON.stringify({ workspaceId: 'ws1', source: 'apollo', missionId: 'm1' }) }),
    ))
  })

  test('surfaces discovery run history including provider failures', async () => {
    const api = makeApi((path) => {
      if (path.includes('/discovery-runs')) return Promise.resolve({ runs: [
        { id: 'r1', source: 'apollo', status: 'FAILED', resultCount: 0, importedCount: 0, skippedCount: 0, errorMessage: 'quota exceeded', startedAt: new Date().toISOString() },
      ] })
      return undefined
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)

    const toggle = await screen.findByText(/Discovery history \(1\)/)
    await userEvent.click(toggle)
    // The failure reason is shown so users can tell "provider failed" from "no results".
    expect(await screen.findByText(/quota exceeded/)).toBeInTheDocument()
  })
})
