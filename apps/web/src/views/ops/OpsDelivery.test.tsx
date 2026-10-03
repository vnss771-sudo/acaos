import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsDelivery } from './OpsDelivery.js'
import type { Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Sparky Co', slug: 'sparky', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

const ECON = {
  actualHours: 530, openShifts: 0, rateCoverage: 1, onCostPct: 0, labourCostCents: 2_420_000, otherCostCents: null,
  revenueCents: null, quotedCents: 6_000_000, estimatedHours: 400, hoursVariancePct: 32.5, revenueVsQuotePct: null,
  labourMarginCents: null, labourMarginPct: null, grossMarginCents: null, grossMarginPct: null, marginBasis: 'UNKNOWN',
  gaps: ['No invoiced revenue entered, so margin is unknown'],
}
const ACTIVE = {
  id: 'j1', status: 'ACTIVE', closeoutVersion: 0, invoicedRevenueCents: null, otherCostCents: null,
  site: { id: 's1', jobCode: 'WH-1', siteName: 'Warehouse fit-out' }, quote: { id: 'q1', amountCents: 6_000_000, estimatedHours: 400 },
  origin: { type: 'OPPORTUNITY', kind: 'DEVELOPMENT_APPLICATION', title: 'DA 2026/123' }, economics: ECON, economicsFrozen: false,
}
const CLOSED = {
  ...ACTIVE, id: 'j2', status: 'COMPLETE', closeoutVersion: 1, site: { id: 's2', jobCode: 'WH-2', siteName: 'Cool room' },
  economics: { ...ECON, revenueCents: 6_200_000, otherCostCents: 2_500_000, grossMarginCents: 1_280_000, grossMarginPct: 20.6, marginBasis: 'GROSS', gaps: [] },
  economicsFrozen: true, shiftsAfterCloseout: 2,
}
const STAT = { n: 3, median: 22, min: 18, max: 30 }
const REPORT = {
  minJobs: 3,
  overall: { key: 'ALL', label: 'All closed jobs', jobs: 3, hoursVariancePct: STAT, revenueVsQuotePct: null, labourMarginPct: STAT, grossMarginPct: STAT },
  groups: [{ key: 'OPPORTUNITY:DEVELOPMENT_APPLICATION', label: 'Development applications', jobs: 3, hoursVariancePct: STAT, revenueVsQuotePct: null, labourMarginPct: STAT, grossMarginPct: null }],
}

function mockApi() {
  return vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method && init.method !== 'GET') return Promise.resolve({ job: {} })
    if (path.startsWith('/api/delivery/report')) return Promise.resolve({ report: REPORT })
    return Promise.resolve({ jobs: [ACTIVE, CLOSED] })
  })
}
const writes = (api: ReturnType<typeof vi.fn>) => api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method && (init as { method: string }).method !== 'GET')

beforeEach(() => vi.clearAllMocks())

describe('OpsDelivery', () => {
  test('non-admins see no economics and no requests are made', () => {
    const api = mockApi()
    render(<OpsDelivery api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(screen.getByText('Admins only')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  test('shows the report with n, job figures, unknowns as unknown, and the gaps', async () => {
    render(<OpsDelivery api={mockApi() as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText('WH-1 · Warehouse fit-out')).toBeInTheDocument()
    expect(screen.getByText('Development applications')).toBeInTheDocument()
    expect(screen.getAllByText('22% (n=3, 18% to 30%)').length).toBeGreaterThan(0)
    expect(screen.getByText('Margin unknown')).toBeInTheDocument()
    expect(screen.getByText('No invoiced revenue entered, so margin is unknown')).toBeInTheDocument()
    expect(screen.getAllByText('+32.5% vs estimate')).toHaveLength(2)
    expect(screen.getByText('Gross margin', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('$12,800')).toBeInTheDocument()
    expect(screen.getByText(/2 shift\(s\) were logged on this site after closeout/)).toBeInTheDocument()
  })

  test('close out sends cents, blank as unknown (null), and on-cost %', async () => {
    const api = mockApi()
    render(<OpsDelivery api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: /close out/i }))
    await userEvent.type(screen.getByLabelText(/Invoiced/), '62,000')
    await userEvent.type(screen.getByLabelText(/on-costs/), '25')
    await userEvent.click(screen.getByRole('button', { name: 'Close out' }))
    const [path, init] = writes(api)[0]
    expect(path).toBe('/api/delivery/jobs/j1/closeout')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1', invoicedRevenueCents: 6_200_000, otherCostCents: null, onCostPct: 25 })
  })

  test('close out rejects junk amounts without calling the API', async () => {
    const api = mockApi()
    render(<OpsDelivery api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: /close out/i }))
    await userEvent.type(screen.getByLabelText(/Invoiced/), 'lots')
    await userEvent.click(screen.getByRole('button', { name: 'Close out' }))
    expect(toast.error).toHaveBeenCalled()
    expect(writes(api)).toHaveLength(0)
  })

  test('reopen needs a reason', async () => {
    const api = mockApi()
    render(<OpsDelivery api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reopen job' }))
    expect(writes(api)).toHaveLength(0)
    await userEvent.type(screen.getByLabelText(/Why reopen/), 'Late variation invoice')
    await userEvent.click(screen.getByRole('button', { name: 'Reopen job' }))
    const [path, init] = writes(api)[0]
    expect(path).toBe('/api/delivery/jobs/j2/reopen')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1', reason: 'Late variation invoice' })
  })
})
