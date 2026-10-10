import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminView } from './Admin.js'
import { makeScorecard } from '../test/scorecardFixture.js'

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
  test('Diagnose opens a read-only diagnostics view for that workspace', async () => {
    const ws = { id: 'w9', name: 'Pilot Electrical', slug: 'pilot', plan: 'growth', subscriptionStatus: 'past_due', createdAt: new Date().toISOString(), memberCount: 2, leadCount: 10, campaignCount: 1, aiCallsThisMonth: 3 }
    const diagnostics = {
      workspace: { id: 'w9', name: 'Pilot Electrical', createdAt: new Date().toISOString(), onboardingCompleted: true },
      sending: { suppressed: false, suppressedReason: null, last24h: { SENT: 4 }, staleSending: 1, staleAfterMinutes: 120,
        reputation: { healthy: true, sends: 40, bounceRate: 0.01, complaintRate: 0, reason: null }, autonomy: { ready: false, optedIn: false, blockers: ['MODE_OFF'] } },
      billing: { plan: 'growth', providerStatus: 'past_due', hasSubscription: true, entitlement: 'grace', effectivePlan: 'growth', graceUntil: new Date().toISOString() },
      mailbox: { smtpConfigured: true, imapConfigured: true, authMethod: 'GOOGLE_OAUTH', oauthConnected: true, oauthActionRequired: true, replySyncStarted: true, domainHealth: 'healthy', domainHealthCheckedAt: null },
      followups: {}, discovery: { runsLast7d: { SUCCEEDED: 3 }, sources: [] },
      recentFailures: [{ type: 'discovery.run_failed', entityType: 'DiscoveryRun', entityId: 'r1', at: new Date().toISOString() }],
      generatedAt: new Date().toISOString(),
    }
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) return Promise.resolve({ ...overview, workspaces: [ws] })
      if (path.includes('/diagnostics')) return Promise.resolve({ diagnostics, release: { version: '1.4.0', commit: 'abcdef1234567890' } })
      if (path.includes('/queue-stats')) return Promise.resolve({ queues: [] })
      if (path.includes('/audit')) return Promise.resolve({ events: [] })
      return Promise.resolve({})
    })
    render(<AdminView api={api as never} toast={toast as never} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Diagnose' }))
    expect(api).toHaveBeenCalledWith('/api/admin/workspaces/w9/diagnostics')
    expect(await screen.findByText('Diagnostics — Pilot Electrical')).toBeInTheDocument()
    expect(screen.getByText(/Stuck in SENDING over 120 min: 1/)).toBeInTheDocument()
    expect(screen.getByText('OAuth needs reconnecting')).toBeInTheDocument()
    expect(screen.getByText(/discovery.run_failed/)).toBeInTheDocument()
  })

  test('lists each contractor pilot against the targets', async () => {
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) return Promise.resolve(overview)
      if (path.includes('/pilot-scorecards')) {
        return Promise.resolve({ pilots: [{ workspace: { id: 'w1', name: 'Sparky Co', createdAt: new Date().toISOString() }, scorecard: makeScorecard() }] })
      }
      if (path.includes('/queue-stats')) return Promise.resolve({ queues: [] })
      if (path.includes('/audit')) return Promise.resolve({ events: [] })
      return Promise.resolve({})
    })
    render(<AdminView api={api as never} toast={toast as never} />)
    expect(await screen.findByText('Contractor pilots')).toBeInTheDocument()
    expect(await screen.findByText('Sparky Co')).toBeInTheDocument()
    expect(screen.getByText('found 1/2 · quotes 1/2')).toBeInTheDocument()
    expect(screen.getByText('1/2 (50%)')).toBeInTheDocument()
    expect(screen.getByText('31% gross margin (1 closed job)')).toBeInTheDocument()
    expect(screen.getByText('Development applications')).toBeInTheDocument()
  })

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

  // Regression: queue-stats and audit previously failed silently (a bare
  // `.catch(() => {})`) — a transient error looked identical to "no queues" /
  // "no audit events" with no indication anything went wrong.
  test('surfaces a toast when the queue-stats request fails', async () => {
    const errorToast = { ...toast, error: vi.fn() }
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) return Promise.resolve(overview)
      if (path.includes('/queue-stats')) return Promise.reject(new Error('boom'))
      if (path.includes('/audit')) return Promise.resolve({ events: [] })
      return Promise.resolve({})
    })
    render(<AdminView api={api as never} toast={errorToast as never} />)
    await waitFor(() => expect(errorToast.error).toHaveBeenCalledWith('Failed to load queue stats'))
  })

  test('surfaces a toast when the audit log request fails', async () => {
    const errorToast = { ...toast, error: vi.fn() }
    const api = vi.fn((path: string) => {
      if (path.includes('/overview')) return Promise.resolve(overview)
      if (path.includes('/queue-stats')) return Promise.resolve({ queues: [] })
      if (path.includes('/audit')) return Promise.reject(new Error('boom'))
      return Promise.resolve({})
    })
    render(<AdminView api={api as never} toast={errorToast as never} />)
    await waitFor(() => expect(errorToast.error).toHaveBeenCalledWith('Failed to load audit log'))
  })
})
