import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsShifts } from './OpsShifts.js'
import type { Workspace, OpsShiftRecord, OpsCrewMember, OpsJobSite } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const crew: OpsCrewMember[] = [
  { id: 'crew1', employeeCode: 'E1', fullName: 'Alex Rivera', role: 'Labourer', isActive: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
]

const jobSites: OpsJobSite[] = [
  { id: 'job1', jobCode: 'J1', siteName: 'Main St Site', status: 'ACTIVE', riskLevel: 'LOW', radiusMeters: 500, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
]

const openShift: OpsShiftRecord = {
  id: 'shift1',
  crewMemberId: 'crew1',
  jobSiteId: 'job1',
  shiftDate: '2026-09-10T00:00:00.000Z',
  startTime: '2026-09-10T08:00:00.000Z',
  endTime: null,
  breakMinutes: 30,
  totalHours: 0,
  allowanceTag: 'NONE',
  outdoorHighRisk: false,
  heatCheckCompleted: false,
  fatigueConcern: false,
  corRelated: false,
  reviewed: false,
  notes: null,
  crewMember: { id: 'crew1', fullName: 'Alex Rivera', employeeCode: 'E1' },
  jobSite: { id: 'job1', siteName: 'Main St Site', jobCode: 'J1' },
}

type ApiCall = [string, { method?: string; body?: string } | undefined]

function apiFor(opts: { shifts?: OpsShiftRecord[]; clockedIn?: boolean; clockStatusShift?: OpsShiftRecord | null } = {}) {
  const { shifts = [], clockedIn = false, clockStatusShift = null } = opts
  return vi.fn((path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith('/api/ops/crew')) return Promise.resolve({ crew })
    if (path.startsWith('/api/ops/jobs')) return Promise.resolve({ jobSites })
    if (path.startsWith('/api/ops/clock/status')) return Promise.resolve({ clockedIn, shift: clockStatusShift })
    if (path.startsWith('/api/ops/clock/in')) return Promise.resolve({ shift: { ...openShift } })
    if (path.startsWith('/api/ops/clock/out')) return Promise.resolve({ shift: { ...openShift, endTime: '2026-09-10T12:00:00.000Z', totalHours: 3.5 } })
    if (path.startsWith('/api/ops/shifts/') && init?.method === 'PUT') return Promise.resolve({ shift: { ...openShift } })
    if (path.startsWith('/api/ops/shifts?')) return Promise.resolve({ shifts, total: shifts.length })
    if (path === '/api/ops/shifts' && init?.method === 'POST') return Promise.resolve({ shift: { ...openShift } })
    return Promise.resolve({})
  })
}

function findCall(api: ReturnType<typeof apiFor>, matcher: (path: string, init?: { method?: string; body?: string }) => boolean): ApiCall | undefined {
  return api.mock.calls.find(c => matcher(c[0] as string, c[1] as { method?: string; body?: string } | undefined)) as ApiCall | undefined
}

afterEach(() => vi.restoreAllMocks())

describe('OpsShifts', () => {
  test('renders shift history from a fake API response', async () => {
    const api = apiFor({ shifts: [openShift] })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} canManage setView={vi.fn()} />)

    const table = await screen.findByRole('table')
    expect(within(table).getByText('Alex Rivera')).toBeInTheDocument()
    expect(within(table).getByText('Main St Site')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/ops/shifts?'))
  })

  test('shows a Clock In button when the selected crew member is not clocked in', async () => {
    const api = apiFor({ clockedIn: false })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} setView={vi.fn()} />)

    // The button only appears after a chained sequence of async effects
    // (fetch crew list -> auto-select the first crew member -> fetch that
    // crew member's clock status -> render). Testing Library's default
    // findBy* timeout (1000ms) covers this comfortably on a normal machine
    // but can be too tight on a loaded CI runner — seen flaking here in CI
    // while passing reliably locally. A longer timeout targets that actual
    // cause without changing what's being asserted.
    expect(await screen.findByRole('button', { name: /Clock In/i }, { timeout: 5000 })).toBeInTheDocument()
  })

  test('shows a Clock Out button and "clocked in" text when the selected crew member is clocked in', async () => {
    const api = apiFor({ clockedIn: true, clockStatusShift: openShift })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} setView={vi.fn()} />)

    // See the timeout comment on the "Clock In" test above — same async chain.
    expect(await screen.findByRole('button', { name: /Clock Out/i }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/Clocked in at/i)).toBeInTheDocument()
  })

  test('clicking Clock In calls the API with the right body', async () => {
    const api = apiFor({ clockedIn: false })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} setView={vi.fn()} />)

    // See the timeout comment on the "shows a Clock In button" test above.
    await screen.findByRole('button', { name: /Clock In/i }, { timeout: 5000 })
    await userEvent.selectOptions(screen.getByLabelText('Job Site'), 'job1')
    await userEvent.click(screen.getByRole('button', { name: /Clock In/i }))

    await waitFor(() => {
      const call = findCall(api, p => p === '/api/ops/clock/in')
      expect(call).toBeTruthy()
      const body = JSON.parse(call![1]!.body!)
      expect(body).toEqual({ workspaceId: 'ws1', crewMemberId: 'crew1', jobSiteId: 'job1' })
    })
    expect(toast.success).toHaveBeenCalled()
  })

  test('the manual-entry modal is hidden for canManage=false', async () => {
    const api = apiFor({ shifts: [openShift] })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} canManage={false} setView={vi.fn()} />)

    await screen.findByRole('table')
    expect(screen.queryByRole('button', { name: /Add Manual Entry/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Add Manual Entry')).not.toBeInTheDocument()
  })

  test('editing an open shift without touching End Time omits endTime from the PUT body', async () => {
    const api = apiFor({ shifts: [openShift] })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} canManage setView={vi.fn()} />)
    await screen.findByRole('table')

    await userEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const notesField = await screen.findByLabelText('Notes')
    await userEvent.type(notesField, 'Reviewed on site')
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => {
      const call = findCall(api, (p, init) => p.startsWith('/api/ops/shifts/') && init?.method === 'PUT')
      expect(call).toBeTruthy()
      const body = JSON.parse(call![1]!.body!)
      expect(body).not.toHaveProperty('endTime')
      expect(body.notes).toBe('Reviewed on site')
    })
  })

  test('editing a shift and setting an explicit End Time DOES include it in the PUT body', async () => {
    const api = apiFor({ shifts: [openShift] })
    render(<OpsShifts api={api as never} workspace={workspace} toast={toast as never} canManage setView={vi.fn()} />)
    await screen.findByRole('table')

    await userEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const endTimeField = await screen.findByLabelText(/End Time/i)
    await userEvent.type(endTimeField, '2026-09-10T16:30')
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => {
      const call = findCall(api, (p, init) => p.startsWith('/api/ops/shifts/') && init?.method === 'PUT')
      expect(call).toBeTruthy()
      const body = JSON.parse(call![1]!.body!)
      expect(body).toHaveProperty('endTime')
      expect(typeof body.endTime).toBe('string')
    })
  })
})
