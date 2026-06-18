import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionsView } from './Missions.js'
import type { Mission, Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1', name: 'Brisbane Trades', goalType: 'BOOK_CALL', status: 'DRAFT',
    targetCustomer: 'Industrial contractors', offer: 'Fleet maintenance',
    createdAt: '2026-06-01T00:00:00Z', campaign: { id: 'c1', name: 'c', goalType: 'BOOK_CALL', createdAt: '', _count: { leads: 3 } },
    ...over,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('MissionsView', () => {
  test('shows the empty state when there are no missions', async () => {
    const api = vi.fn().mockResolvedValue({ missions: [] })
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/No missions yet/i)).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/missions?workspaceId=ws1')
  })

  test('renders a mission card with status, target, offer and lead count', async () => {
    const api = vi.fn().mockResolvedValue({ missions: [mission()] })
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText('Brisbane Trades')).toBeInTheDocument()
    expect(screen.getByText('DRAFT')).toBeInTheDocument()
    expect(screen.getByText(/Industrial contractors/)).toBeInTheDocument()
    expect(screen.getByText(/Fleet maintenance/)).toBeInTheDocument()
    expect(screen.getByText(/3 leads enrolled/)).toBeInTheDocument()
  })

  test('a DRAFT mission offers Activate; activating PATCHes status to ACTIVE', async () => {
    const api = vi.fn((path: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return Promise.resolve({ mission: mission({ status: 'ACTIVE' }) })
      return Promise.resolve({ missions: [mission({ status: 'DRAFT' })] })
    })
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Activate' }))
    expect(api).toHaveBeenCalledWith('/api/missions/m1', expect.objectContaining({ method: 'PATCH' }))
    const patch = api.mock.calls.find(c => (c[1] as any)?.method === 'PATCH')!
    expect(JSON.parse((patch[1] as any).body)).toMatchObject({ status: 'ACTIVE' })
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Mission active')
  })

  test('an ACTIVE mission offers Pause and Complete (not Activate)', async () => {
    const api = vi.fn().mockResolvedValue({ missions: [mission({ status: 'ACTIVE' })] })
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Brisbane Trades')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
  })

  test('a COMPLETE mission exposes no lifecycle actions', async () => {
    const api = vi.fn().mockResolvedValue({ missions: [mission({ status: 'COMPLETE' })] })
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Brisbane Trades')
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
  })

  test('surfaces a toast when loading missions fails', async () => {
    const api = vi.fn().mockRejectedValue(new Error('boom'))
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} />)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
  })

  test('renders nothing without a workspace', () => {
    const api = vi.fn()
    const { container } = render(<MissionsView api={api as never} workspace={null} toast={toast as never} />)
    expect(container).toBeEmptyDOMElement()
    expect(api).not.toHaveBeenCalled()
  })
})
