import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Campaigns } from './Campaigns.js'
import type { Campaign, Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const campaign: Campaign = {
  id: 'c1', name: 'Q3 Brisbane Outreach', goalType: 'BOOK_CALL',
  description: 'Target trades', _count: { leads: 12 }, createdAt: '2026-06-01T00:00:00Z',
}

afterEach(() => vi.restoreAllMocks())

describe('Campaigns', () => {
  test('shows the empty state when there are no campaigns', async () => {
    const api = vi.fn().mockResolvedValue({ campaigns: [] })
    render(<Campaigns api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/No campaigns yet/i)).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/campaigns?workspaceId=ws1')
  })

  test('renders the campaign list with goal and lead count', async () => {
    const api = vi.fn().mockResolvedValue({ campaigns: [campaign] })
    render(<Campaigns api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText('Q3 Brisbane Outreach')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()       // leads
    expect(screen.getByText('BOOK CALL')).toBeInTheDocument() // goal type, underscores stripped
  })

  test('creating a campaign posts it and prepends it to the list', async () => {
    const created: Campaign = { id: 'c2', name: 'New Pilot', goalType: 'BOOK_CALL', createdAt: '2026-06-12T00:00:00Z', _count: { leads: 0 } }
    const api = vi.fn((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ campaign: created })
      return Promise.resolve({ campaigns: [] })
    })
    render(<Campaigns api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(screen.getByRole('button', { name: /New Campaign/i }))
    await userEvent.type(screen.getByPlaceholderText('Q3 Brisbane Outreach'), 'New Pilot')
    await userEvent.click(screen.getByRole('button', { name: 'Create Campaign' }))

    expect(api).toHaveBeenCalledWith('/api/campaigns', expect.objectContaining({ method: 'POST' }))
    expect(await screen.findByText('New Pilot')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Campaign created')
  })

  test('deleting a campaign (confirmed) removes it from the list', async () => {
    vi.stubGlobal('confirm', () => true)
    const api = vi.fn((path: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return Promise.resolve({})
      return Promise.resolve({ campaigns: [campaign] })
    })
    render(<Campaigns api={api as never} workspace={workspace} toast={toast as never} />)

    await screen.findByText('Q3 Brisbane Outreach')
    await userEvent.click(screen.getByRole('button', { name: '✕' }))

    expect(api).toHaveBeenCalledWith('/api/campaigns/c1', expect.objectContaining({ method: 'DELETE' }))
    await waitFor(() => expect(screen.queryByText('Q3 Brisbane Outreach')).not.toBeInTheDocument())
  })
})
