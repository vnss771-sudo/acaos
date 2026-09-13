import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsAlerts } from './OpsAlerts.js'
import type { OpsAlert, Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

const openAlert: OpsAlert = {
  id: 'a1',
  alertType: 'MISSING_HEAT_CHECK',
  title: 'Missing heat check on Site A',
  severity: 'HIGH',
  status: 'OPEN',
  createdAt: '2026-09-10T00:00:00.000Z',
} as OpsAlert

const reviewedAlert: OpsAlert = {
  id: 'a2',
  alertType: 'FATIGUE_THRESHOLD',
  title: 'Fatigue threshold exceeded',
  severity: 'MEDIUM',
  status: 'REVIEWED',
  reviewedBy: 'user-9',
  createdAt: '2026-09-09T00:00:00.000Z',
} as OpsAlert

function apiFor(alerts: OpsAlert[]) {
  return vi.fn((path: string, _init?: Record<string, unknown>) => {
    if (path.includes('/review')) return Promise.resolve({ alert: { ...alerts[0], status: 'REVIEWED' } })
    if (path.startsWith('/api/ops/alerts/counts')) return Promise.resolve({ open: 1, reviewed: 1, openHigh: 1 })
    if (path.startsWith('/api/ops/alerts?')) return Promise.resolve({ alerts, total: alerts.length, page: 1, limit: 25, pages: 1 })
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('OpsAlerts', () => {
  test('fetches and renders alerts in the table', async () => {
    const api = apiFor([openAlert, reviewedAlert])
    render(<OpsAlerts api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)

    expect(await screen.findByText('Missing heat check on Site A')).toBeInTheDocument()
    expect(screen.getByText('Fatigue threshold exceeded')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/ops/alerts?'))
  })

  test('an OPEN alert shows Mark Reviewed when canManage, a REVIEWED one does not', async () => {
    const api = apiFor([openAlert, reviewedAlert])
    render(<OpsAlerts api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Missing heat check on Site A')

    const buttons = screen.getAllByRole('button', { name: /Mark Reviewed/i })
    expect(buttons).toHaveLength(1)
  })

  test('canManage=false hides the Mark Reviewed button entirely', async () => {
    const api = apiFor([openAlert, reviewedAlert])
    render(<OpsAlerts api={api as never} workspace={workspace} toast={toast as never} canManage={false} setView={setView} />)
    await screen.findByText('Missing heat check on Site A')

    expect(screen.queryByRole('button', { name: /Mark Reviewed/i })).not.toBeInTheDocument()
  })

  test('clicking Mark Reviewed calls the review endpoint with the right params', async () => {
    const api = apiFor([openAlert, reviewedAlert])
    render(<OpsAlerts api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await screen.findByText('Missing heat check on Site A')

    await userEvent.click(screen.getByRole('button', { name: /Mark Reviewed/i }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        `/api/ops/alerts/${openAlert.id}/review`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspaceId: workspace.id }) })
      )
    })
    expect(toast.success).toHaveBeenCalled()
  })

  test('shows the empty state when there are no alerts', async () => {
    const api = apiFor([])
    render(<OpsAlerts api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText(/No alerts/i)).toBeInTheDocument()
  })
})
