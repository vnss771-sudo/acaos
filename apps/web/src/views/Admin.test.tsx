import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AdminView } from './Admin.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

const overview = {
  workspaces: [],
  totals: { workspaceCount: 1, paidWorkspaces: 0, totalLeads: 0, totalCampaigns: 0, totalAiCalls: 0 },
}

function makeApi() {
  return vi.fn((path: string) => {
    if (path.includes('/overview')) return Promise.resolve(overview)
    if (path.includes('/queue-stats')) return Promise.resolve({ queues: [] })
    if (path.includes('/audit')) return Promise.resolve({ events: [
      { id: 'a1', type: 'campaign.send', entityType: 'campaign', entityId: 'c1', metadata: { eligible: 3 }, createdAt: new Date().toISOString() },
      { id: 'a2', type: 'email.bounced', entityType: 'suppression', entityId: null, metadata: { email: 'x@y.test' }, createdAt: new Date().toISOString() },
    ] })
    return Promise.resolve({})
  })
}

describe('AdminView', () => {
  test('renders the audit log panel with recent events', async () => {
    render(<AdminView api={makeApi() as never} toast={toast as never} />)
    expect(await screen.findByText('Recent Activity (Audit Log)')).toBeInTheDocument()
    expect(await screen.findByText('campaign.send')).toBeInTheDocument()
    expect(await screen.findByText('email.bounced')).toBeInTheDocument()
  })

  test('renders KPI totals and the workspace table from the overview', async () => {
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) {
        return Promise.resolve({
          workspaces: [{
            id: 'w1', name: 'Acme Co', slug: 'acme', plan: 'growth', subscriptionStatus: 'active',
            createdAt: new Date().toISOString(), memberCount: 3, leadCount: 120, campaignCount: 4, aiCallsThisMonth: 42,
          }],
          totals: { workspaceCount: 1, paidWorkspaces: 1, totalLeads: 120, totalCampaigns: 4, totalAiCalls: 42 },
        })
      }
      if (path.includes('/queue-stats')) return Promise.resolve({ queues: [] })
      if (path.includes('/audit')) return Promise.resolve({ events: [] })
      return Promise.resolve({})
    })
    render(<AdminView api={api as never} toast={toast as never} />)
    // KPI tiles + the workspace row come from the overview payload.
    expect(await screen.findByText('All Workspaces')).toBeInTheDocument()
    expect(await screen.findByText('Acme Co')).toBeInTheDocument()
    expect(screen.getByText('acme')).toBeInTheDocument()
  })

  test('shows the worker queue health panel only when queues are present', async () => {
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) return Promise.resolve(overview)
      if (path.includes('/queue-stats')) return Promise.resolve({ queues: [{ name: 'send-email', active: 1, waiting: 2, completed: 10, failed: 0 }] })
      if (path.includes('/audit')) return Promise.resolve({ events: [] })
      return Promise.resolve({})
    })
    render(<AdminView api={api as never} toast={toast as never} />)
    expect(await screen.findByText('Worker Queue Health')).toBeInTheDocument()
    expect(await screen.findByText('send-email')).toBeInTheDocument()
  })

  test('surfaces a toast when the overview request fails', async () => {
    const errorToast = { ...toast, error: vi.fn() }
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) return Promise.reject(new Error('boom'))
      return Promise.resolve({ queues: [], events: [] })
    })
    render(<AdminView api={api as never} toast={errorToast as never} />)
    await waitFor(() => expect(errorToast.error).toHaveBeenCalledWith('Failed to load admin overview'))
  })
})
