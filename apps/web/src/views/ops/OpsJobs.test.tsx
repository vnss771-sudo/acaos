import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsJobs } from './OpsJobs.js'
import type { OpsJobSite, Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

const site: OpsJobSite = {
  id: 'j1', jobCode: 'SITE-001', siteName: 'Riverside Depot', location: '12 River Rd',
  supervisor: 'Pat Nguyen', status: 'ACTIVE', shiftType: 'Day', riskLevel: 'HIGH',
  lat: null, lng: null, radiusMeters: 500, notes: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

function apiFor(jobSites: OpsJobSite[]) {
  return vi.fn((path: string, _init?: Record<string, unknown>) => {
    if (path.startsWith('/api/ops/jobs?')) return Promise.resolve({ jobSites, total: jobSites.length, page: 1, limit: 25, pages: 1 })
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('OpsJobs', () => {
  test('fetches and renders job sites in the table', async () => {
    const api = apiFor([site])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)

    expect(await screen.findByText('Riverside Depot')).toBeInTheDocument()
    expect(screen.getByText('SITE-001')).toBeInTheDocument()
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/ops/jobs?'))
  })

  test('shows the empty state when there are no job sites', async () => {
    const api = apiFor([])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText(/No job sites yet/i)).toBeInTheDocument()
  })

  test('a member (canManage=false) sees job sites but no Add/Edit/Archive controls', async () => {
    const api = apiFor([site])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage={false} setView={setView} />)
    expect(await screen.findByText('Riverside Depot')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Job Site/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archive/i })).not.toBeInTheDocument()
  })

  test('changing the status filter refetches with the status query', async () => {
    const api = apiFor([site])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Riverside Depot')

    await userEvent.selectOptions(screen.getByRole('combobox'), 'ARCHIVED')
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining('status=ARCHIVED')))
  })

  test('opening the Add modal and submitting posts the job site', async () => {
    const api = apiFor([site])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Riverside Depot')

    await userEvent.click(screen.getByRole('button', { name: /Add Job Site/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/Job Code/i), 'SITE-002')
    await userEvent.type(screen.getByLabelText(/Site Name/i), 'North Yard')

    await userEvent.click(screen.getByRole('button', { name: /^Add Job Site$/i }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/ops/jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws1', jobCode: 'SITE-002', siteName: 'North Yard', riskLevel: 'MEDIUM', radiusMeters: 500 }),
      }),
    ))
    expect(toast.success).toHaveBeenCalled()
  })

  test('editing a job site shows jobCode read-only, has no status field, and submits a PUT', async () => {
    const api = apiFor([site])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Riverside Depot')

    await userEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('SITE-001')).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox', { name: /Job Code/i })).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^Status$/i)).not.toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/ops/jobs/j1',
      expect.objectContaining({ method: 'PUT' }),
    ))
  })

  test('archiving a job site opens a confirm modal and calls DELETE with workspaceId', async () => {
    const api = apiFor([site])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Riverside Depot')

    await userEvent.click(screen.getByRole('button', { name: /Archive/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Archive job site\?/i)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /^Archive$/i }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/ops/jobs/j1?workspaceId=ws1',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    const deleteCall = api.mock.calls.find(([path]) => path === '/api/ops/jobs/j1?workspaceId=ws1')
    expect(deleteCall?.[1]).not.toHaveProperty('body')
  })

  test('an already-archived site shows no Archive button', async () => {
    const archived: OpsJobSite = { ...site, status: 'ARCHIVED' }
    const api = apiFor([archived])
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Riverside Depot')

    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archive/i })).not.toBeInTheDocument()
  })

  test('a duplicate job code 409 surfaces via toast.error', async () => {
    const api = vi.fn((path: string) => {
      if (path.startsWith('/api/ops/jobs?')) return Promise.resolve({ jobSites: [site], total: 1, page: 1, limit: 25, pages: 1 })
      if (path === '/api/ops/jobs') return Promise.reject(new Error('A job site with this job code already exists'))
      return Promise.resolve({})
    })
    render(<OpsJobs api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Riverside Depot')

    await userEvent.click(screen.getByRole('button', { name: /Add Job Site/i }))
    await userEvent.type(screen.getByLabelText(/Job Code/i), 'SITE-001')
    await userEvent.type(screen.getByLabelText(/Site Name/i), 'Dup Site')
    await userEvent.click(screen.getByRole('button', { name: /^Add Job Site$/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A job site with this job code already exists'))
  })
})
