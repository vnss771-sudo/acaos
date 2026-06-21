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
  test('shows an empty state when no workspace is selected', async () => {
    const api = makeApi()
    render(<ProspectsView api={api as never} workspace={null} toast={toast as never} canManage />)
    expect(screen.getByText('No workspace selected')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalledWith(expect.stringContaining('/api/prospects?workspaceId'))
    await waitFor(() => expect(api).not.toHaveBeenCalledWith('/api/prospects/sources'))
  })

  test('fetches and renders prospects with their opportunity score', async () => {
    const api = makeApi((path) => {
      if (path.includes('/sources')) return Promise.resolve({ sources: [] })
      if (path.includes('/api/prospects?')) return Promise.resolve({ prospects: [prospect], total: 1 })
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage />)

    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument()
    expect(screen.getByText('84')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/prospects?workspaceId=ws1&limit=100')
  })

  test('a member (canManage=false) sees prospects but no import/export/discover/add controls', async () => {
    const api = makeApi((path) => {
      if (path.includes('/sources')) return Promise.resolve({ sources: [{ name: 'apollo', label: 'Apollo' }] })
      if (path.includes('/api/prospects?')) return Promise.resolve({ prospects: [prospect], total: 1 })
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage={false} />)
    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument() // read access intact
    expect(screen.queryByRole('button', { name: /Import CSV/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export CSV/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Prospect/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Apollo/i })).not.toBeInTheDocument()
  })

  test('shows the empty state when the workspace has no prospects', async () => {
    const api = makeApi()
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    expect(await screen.findByText(/No prospects yet/i)).toBeInTheDocument()
  })

  test('typing in search refetches with the search query', async () => {
    const api = makeApi()
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage />)

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
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage />)

    // Pick the mission, then trigger discovery.
    const select = await screen.findByTitle('Attribute discovered prospects to a mission')
    await userEvent.selectOptions(select, 'm1')
    await userEvent.click(await screen.findByText('⚡ Apollo'))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/prospects/discover',
      expect.objectContaining({ body: JSON.stringify({ workspaceId: 'ws1', source: 'apollo', missionId: 'm1' }) }),
    ))
  })

  test('select-all then Rescore selected loops the per-prospect endpoint', async () => {
    const prospect2 = { ...prospect, id: 'p2', companyName: 'Apex Plumbing' } as unknown as Prospect
    const api = makeApi((path) => {
      if (path.includes('/sources')) return Promise.resolve({ sources: [] })
      if (path.includes('/api/prospects?')) return Promise.resolve({ prospects: [prospect, prospect2], total: 2 })
      if (path.endsWith('/rescore')) return Promise.resolve({})
      return undefined
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Meridian Roofing')

    await userEvent.click(screen.getByLabelText('Select all rows'))
    await userEvent.click(screen.getByRole('button', { name: /Rescore selected/i }))

    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prospects/p1/rescore', { method: 'POST' }))
    expect(api).toHaveBeenCalledWith('/api/prospects/p2/rescore', { method: 'POST' })
  })

  test('bulk controls are hidden for members (canManage=false)', async () => {
    const api = makeApi((path) => {
      if (path.includes('/sources')) return Promise.resolve({ sources: [] })
      if (path.includes('/api/prospects?')) return Promise.resolve({ prospects: [prospect], total: 1 })
      return undefined
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage={false} />)
    await screen.findByText('Meridian Roofing')
    expect(screen.queryByLabelText('Select all rows')).not.toBeInTheDocument()
  })

  test('surfaces discovery run history including provider failures', async () => {
    const api = makeApi((path) => {
      if (path.includes('/discovery-runs')) return Promise.resolve({ runs: [
        { id: 'r1', source: 'apollo', status: 'FAILED', resultCount: 0, importedCount: 0, skippedCount: 0, errorMessage: 'quota exceeded', startedAt: new Date().toISOString() },
      ] })
      return undefined
    })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} canManage />)

    const toggle = await screen.findByText(/Discovery history \(1\)/)
    await userEvent.click(toggle)
    // The failure reason is shown so users can tell "provider failed" from "no results".
    expect(await screen.findByText(/quota exceeded/)).toBeInTheDocument()
  })
})
