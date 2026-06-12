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

describe('ProspectsView', () => {
  test('shows an empty state when no workspace is selected', () => {
    const api = vi.fn()
    render(<ProspectsView api={api as never} workspace={null} toast={toast as never} />)
    expect(screen.getByText('No workspace selected')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  test('fetches and renders prospects with their opportunity score', async () => {
    const api = vi.fn().mockResolvedValue({ prospects: [prospect], total: 1 })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument()
    expect(screen.getByText('84')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/prospects?workspaceId=ws1&limit=100')
  })

  test('shows the empty state when the workspace has no prospects', async () => {
    const api = vi.fn().mockResolvedValue({ prospects: [], total: 0 })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/No prospects yet/i)).toBeInTheDocument()
  })

  test('typing in search refetches with the search query', async () => {
    const api = vi.fn().mockResolvedValue({ prospects: [], total: 0 })
    render(<ProspectsView api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.type(screen.getByPlaceholderText('Search prospects…'), 'acme')
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining('search=acme')),
    )
  })
})
