import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsCrew } from './OpsCrew.js'
import type { OpsCrewMember, Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

const member: OpsCrewMember = {
  id: 'c1', employeeCode: 'EMP-001', fullName: 'Jamie Rivera', role: 'Electrician',
  crewName: 'Team A', baseRate: 42, allowanceProfile: null, licenceNotes: null,
  isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

function apiFor(crew: OpsCrewMember[]) {
  return vi.fn((path: string, _init?: Record<string, unknown>) => {
    if (path.startsWith('/api/ops/crew?')) return Promise.resolve({ crew, total: crew.length, page: 1, limit: 25, pages: 1 })
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('OpsCrew', () => {
  test('fetches and renders crew in the table', async () => {
    const api = apiFor([member])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)

    expect(await screen.findByText('Jamie Rivera')).toBeInTheDocument()
    expect(screen.getByText('EMP-001')).toBeInTheDocument()
    expect(screen.getByText('$42/hr')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/ops/crew?'))
  })

  test('shows the empty state when there are no crew members', async () => {
    const api = apiFor([])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText(/No crew members yet/i)).toBeInTheDocument()
  })

  test('a member (canManage=false) sees crew but no Add/Edit/Deactivate controls', async () => {
    const api = apiFor([member])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage={false} setView={setView} />)
    expect(await screen.findByText('Jamie Rivera')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Crew Member/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Deactivate/i })).not.toBeInTheDocument()
  })

  test('the "Active only" checkbox refetches with active=true', async () => {
    const api = apiFor([member])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Jamie Rivera')

    await userEvent.click(screen.getByRole('checkbox', { name: /Active only/i }))
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining('active=true')))
  })

  test('opening the Add modal and submitting posts the crew member', async () => {
    const api = apiFor([member])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Jamie Rivera')

    await userEvent.click(screen.getByRole('button', { name: /Add Crew Member/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/Employee Code/i), 'EMP-002')
    await userEvent.type(screen.getByLabelText(/Full Name/i), 'Sam Lee')
    await userEvent.type(screen.getByLabelText(/^Role$/i), 'Plumber')

    await userEvent.click(screen.getByRole('button', { name: /^Add Crew Member$/i, hidden: false }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/ops/crew',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws1', employeeCode: 'EMP-002', fullName: 'Sam Lee', role: 'Plumber' }),
      }),
    ))
    expect(toast.success).toHaveBeenCalled()
  })

  test('editing a crew member shows employeeCode read-only and submits a PUT', async () => {
    const api = apiFor([member])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Jamie Rivera')

    await userEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('EMP-001')).toBeInTheDocument()
    // employeeCode is rendered read-only, not as an editable input
    expect(within(dialog).queryByRole('textbox', { name: /Employee Code/i })).not.toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/ops/crew/c1',
      expect.objectContaining({ method: 'PUT' }),
    ))
  })

  test('deactivating a crew member opens a confirm modal and calls DELETE with workspaceId', async () => {
    const api = apiFor([member])
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Jamie Rivera')

    await userEvent.click(screen.getByRole('button', { name: /Deactivate/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Deactivate crew member\?/i)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /^Deactivate$/i }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/ops/crew/c1?workspaceId=ws1',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    // Bodyless DELETE — no JSON body should be sent on this call.
    const deleteCall = api.mock.calls.find(([path]) => path === '/api/ops/crew/c1?workspaceId=ws1')
    expect(deleteCall?.[1]).not.toHaveProperty('body')
  })

  test('a duplicate employee code 409 surfaces via toast.error', async () => {
    const api = vi.fn((path: string) => {
      if (path.startsWith('/api/ops/crew?')) return Promise.resolve({ crew: [member], total: 1, page: 1, limit: 25, pages: 1 })
      if (path === '/api/ops/crew') return Promise.reject(new Error('A crew member with this employee code already exists'))
      return Promise.resolve({})
    })
    render(<OpsCrew api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Jamie Rivera')

    await userEvent.click(screen.getByRole('button', { name: /Add Crew Member/i }))
    await userEvent.type(screen.getByLabelText(/Employee Code/i), 'EMP-001')
    await userEvent.type(screen.getByLabelText(/Full Name/i), 'Dup Person')
    await userEvent.type(screen.getByLabelText(/^Role$/i), 'Roofer')
    await userEvent.click(screen.getByRole('button', { name: /^Add Crew Member$/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A crew member with this employee code already exists'))
  })
})
