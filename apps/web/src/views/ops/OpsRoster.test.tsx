import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsRoster } from './OpsRoster.js'
import type { Workspace, OpsRosterEntry, OpsCrewMember, OpsJobSite } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const crewMember: OpsCrewMember = {
  id: 'crew1', employeeCode: 'E1', fullName: 'Jane Doe', role: 'Electrician',
  isActive: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const jobSite: OpsJobSite = {
  id: 'site1', jobCode: 'J1', siteName: 'Downtown Tower', status: 'ACTIVE' as OpsJobSite['status'],
  riskLevel: 'LOW' as OpsJobSite['riskLevel'], radiusMeters: 100, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const draftEntry: OpsRosterEntry = {
  id: 'r1', crewMemberId: 'crew1', jobSiteId: 'site1',
  rosterDate: '2026-09-15T00:00:00.000Z', startTime: '2026-09-15T08:00:00.000Z', endTime: '2026-09-15T16:00:00.000Z',
  shiftType: 'REGULAR', status: 'DRAFT',
  crewMember: { id: 'crew1', fullName: 'Jane Doe', employeeCode: 'E1' },
  jobSite: { id: 'site1', siteName: 'Downtown Tower', jobCode: 'J1' },
}

const publishedEntry: OpsRosterEntry = {
  id: 'r2', crewMemberId: 'crew1', jobSiteId: 'site1',
  rosterDate: '2026-09-16T00:00:00.000Z', startTime: '2026-09-16T08:00:00.000Z', endTime: '2026-09-16T16:00:00.000Z',
  shiftType: 'OVERTIME', status: 'PUBLISHED',
  crewMember: { id: 'crew1', fullName: 'Jane Doe', employeeCode: 'E1' },
  jobSite: { id: 'site1', siteName: 'Downtown Tower', jobCode: 'J1' },
}

function apiFor(entries: OpsRosterEntry[], overrides: Record<string, unknown> = {}) {
  return vi.fn((path: string, init?: Record<string, unknown>) => {
    if (path.startsWith('/api/ops/roster/summary')) {
      return Promise.resolve({ draftCount: 1, publishedThisWeekCount: 1, activeJobSiteCount: 1 })
    }
    if (path.startsWith('/api/ops/roster/publish')) {
      return Promise.resolve(overrides.publish ?? { published: 2 })
    }
    if (path.startsWith('/api/ops/roster?')) {
      return Promise.resolve({ entries, total: entries.length, page: 1, limit: 25, pages: 1 })
    }
    if (path.startsWith('/api/ops/roster/') && init?.method === 'DELETE') {
      return Promise.resolve({ deleted: true, id: 'r1' })
    }
    if (path.startsWith('/api/ops/roster/')) {
      return Promise.resolve(overrides.update ?? { entry: draftEntry })
    }
    if (path.startsWith('/api/ops/roster')) {
      return Promise.resolve(overrides.create ?? { entry: draftEntry })
    }
    if (path.startsWith('/api/ops/crew')) {
      return Promise.resolve({ crew: [crewMember], total: 1 })
    }
    if (path.startsWith('/api/ops/jobs')) {
      return Promise.resolve({ jobSites: [jobSite], total: 1 })
    }
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('OpsRoster', () => {
  test('fetches and renders roster entries from the API', async () => {
    const api = apiFor([draftEntry])
    render(<OpsRoster api={api as never} workspace={workspace} toast={toast as never} canManage setView={() => {}} />)

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('Downtown Tower')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/ops/roster?'))
  })

  test('a DRAFT row shows Edit/Delete, a PUBLISHED row shows neither', async () => {
    const api = apiFor([draftEntry, publishedEntry])
    render(<OpsRoster api={api as never} workspace={workspace} toast={toast as never} canManage setView={() => {}} />)
    await screen.findAllByText('Downtown Tower')

    const rows = screen.getAllByRole('row').slice(1) // skip header row
    expect(rows.length).toBe(2)

    // Exactly one Edit and one Delete button should exist across the table
    // (rendered only for the DRAFT row — the PUBLISHED row gets none).
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
  })

  test('canManage=false hides Add Entry, Publish Range, Edit and Delete', async () => {
    const api = apiFor([draftEntry])
    render(<OpsRoster api={api as never} workspace={workspace} toast={toast as never} canManage={false} setView={() => {}} />)
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /Add Entry/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Publish Range/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  test('shows the empty state when there are no entries', async () => {
    const api = apiFor([])
    render(<OpsRoster api={api as never} workspace={workspace} toast={toast as never} canManage setView={() => {}} />)
    expect(await screen.findByText(/No roster entries/i)).toBeInTheDocument()
  })

  test('submitting the Add Entry modal calls the API with the right body shape', async () => {
    const api = apiFor([draftEntry])
    render(<OpsRoster api={api as never} workspace={workspace} toast={toast as never} canManage setView={() => {}} />)
    await screen.findByText('Jane Doe')

    await userEvent.click(screen.getByRole('button', { name: /Add Entry/i }))
    expect(screen.getByText('Add Roster Entry')).toBeInTheDocument()

    const dialog = screen.getByRole('dialog', { name: 'Add Roster Entry' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Crew Member'), 'crew1')
    await userEvent.selectOptions(within(dialog).getByLabelText('Job Site'), 'site1')
    fireEvent.change(within(dialog).getByLabelText('Roster Date'), { target: { value: '2026-09-20T08:00' } })
    fireEvent.change(within(dialog).getByLabelText('Start Time'), { target: { value: '2026-09-20T08:00' } })
    fireEvent.change(within(dialog).getByLabelText('End Time'), { target: { value: '2026-09-20T16:00' } })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Entry' }))

    await waitFor(() => {
      const call = (api as ReturnType<typeof vi.fn>).mock.calls.find(c => c[0] === '/api/ops/roster' && c[1]?.method === 'POST')
      expect(call).toBeTruthy()
      const body = JSON.parse(call![1].body)
      expect(body).toMatchObject({
        workspaceId: 'ws1',
        crewMemberId: 'crew1',
        jobSiteId: 'site1',
        shiftType: 'REGULAR',
      })
      expect(typeof body.rosterDate).toBe('string')
      expect(typeof body.startTime).toBe('string')
      expect(typeof body.endTime).toBe('string')
    })
    expect(toast.success).toHaveBeenCalled()
  })

  test('the Publish modal calls the publish endpoint with the entered date range', async () => {
    const api = apiFor([draftEntry])
    render(<OpsRoster api={api as never} workspace={workspace} toast={toast as never} canManage setView={() => {}} />)
    await screen.findByText('Jane Doe')

    await userEvent.click(screen.getByRole('button', { name: /Publish Range/i }))
    const dialog = screen.getByRole('dialog', { name: 'Publish Roster Range' })

    const fromInput = within(dialog).getByLabelText('From') as HTMLInputElement
    const toInput = within(dialog).getByLabelText('To') as HTMLInputElement
    fireEvent.change(fromInput, { target: { value: '2026-09-15' } })
    fireEvent.change(toInput, { target: { value: '2026-09-21' } })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))

    await waitFor(() => {
      const call = (api as ReturnType<typeof vi.fn>).mock.calls.find(c => c[0] === '/api/ops/roster/publish')
      expect(call).toBeTruthy()
      const body = JSON.parse(call![1].body)
      expect(body.workspaceId).toBe('ws1')
      expect(body.from).toBe(new Date('2026-09-15').toISOString())
      expect(body.to).toBe(new Date('2026-09-21').toISOString())
    })
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('2'))
  })
})
