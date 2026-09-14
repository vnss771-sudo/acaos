import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Leads } from './Leads.js'
import type { Lead, Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const lead = { id: 'l1', businessName: 'Acme Plumbing', stage: 'NEW', score: 60, category: 'Plumbing' } as Lead

function apiFor(leads: Lead[]) {
  return vi.fn((path: string) => {
    if (path.startsWith('/api/leads?')) return Promise.resolve({ leads, total: leads.length })
    if (path.startsWith('/api/campaigns')) return Promise.resolve({ campaigns: [] })
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('Leads', () => {
  test('fetches and renders leads in the table', async () => {
    const api = apiFor([lead])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)

    expect(await screen.findByText('Acme Plumbing')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/leads?'))
  })

  test('a member (canManage=false) sees leads but no import/export/add controls', async () => {
    const api = apiFor([lead])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage={false} />)
    expect(await screen.findByText('Acme Plumbing')).toBeInTheDocument() // read access intact
    expect(screen.queryByRole('button', { name: /Import CSV/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export CSV/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Lead/i })).not.toBeInTheDocument()
  })

  test('shows the empty state when there are no leads', async () => {
    const api = apiFor([])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)
    expect(await screen.findByText(/No leads found/i)).toBeInTheDocument()
  })

  test('changing the stage filter refetches with the stage query', async () => {
    const api = apiFor([lead])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Acme Plumbing')

    const stageSelect = screen.getAllByRole('combobox').find(el => within(el).queryByText('All stages'))!
    await userEvent.selectOptions(stageSelect, 'NEW')

    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining('stage=NEW')))
  })

  test('the Add Lead button reveals the new-lead form', async () => {
    const api = apiFor([lead])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Acme Plumbing')

    expect(screen.queryByText('New Lead')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Add Lead/i }))
    expect(screen.getByText('New Lead')).toBeInTheDocument()
  })

  test('deleting a lead asks for confirmation via a dialog, not the browser confirm()', async () => {
    const api = apiFor([lead])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Acme Plumbing')

    await userEvent.click(screen.getByRole('button', { name: /Delete lead Acme Plumbing/i }))
    expect(screen.getByRole('dialog', { name: /Delete lead\?/i })).toBeInTheDocument()
    // Nothing sent yet — the delete only fires once confirmed.
    expect(api).not.toHaveBeenCalledWith('/api/leads/l1', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/leads/l1', expect.objectContaining({ method: 'DELETE' })))
    expect(screen.queryByRole('dialog', { name: /Delete lead\?/i })).not.toBeInTheDocument()
  })

  test('shows a persistent error banner (not just a toast) when the load fails, and Retry reloads', async () => {
    const api = vi.fn((path: string) => {
      if (path.startsWith('/api/leads?')) return Promise.reject(new Error('Network error'))
      if (path.startsWith('/api/campaigns')) return Promise.resolve({ campaigns: [] })
      return Promise.resolve({})
    })
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to load leads/i)
    expect(toast.error).toHaveBeenCalled()

    // A subsequent successful retry clears the banner — it isn't stuck on
    // once shown.
    api.mockImplementation((path: string) => {
      if (path.startsWith('/api/leads?')) return Promise.resolve({ leads: [lead], total: 1 })
      if (path.startsWith('/api/campaigns')) return Promise.resolve({ campaigns: [] })
      return Promise.resolve({})
    })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Acme Plumbing')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('cancelling the delete confirmation leaves the lead untouched', async () => {
    const api = apiFor([lead])
    render(<Leads api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Acme Plumbing')

    await userEvent.click(screen.getByRole('button', { name: /Delete lead Acme Plumbing/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: /Delete lead\?/i })).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalledWith('/api/leads/l1', expect.anything())
    expect(screen.getByText('Acme Plumbing')).toBeInTheDocument()
  })
})
