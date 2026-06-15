import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
