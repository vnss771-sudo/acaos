import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AutonomySection } from './AutonomySection.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

const status = (over: Record<string, unknown> = {}) => ({
  ready: false, mode: 'off', blockers: ['MODE_OFF', 'NOT_OPTED_IN', 'TOO_FEW_REVIEWED_DRAFTS'], optedIn: false, optInAt: null,
  consentVersion: '2026-10-10.v1', approvalModeOff: true,
  metrics: { reviewedDrafts: 3, approvalRate: 1, policyReviewRate: 0, sends: 0, bounceRate: 0, complaintRate: 0 },
  thresholds: { minReviewedDrafts: 20, minApprovalRate: 0.9, maxPolicyReviewRate: 0.05, minSends: 50 },
  ...over,
})

describe('AutonomySection', () => {
  test('shows human approval and every reason automatic sending is blocked', async () => {
    const api = vi.fn(() => Promise.resolve(status()))
    render(<AutonomySection api={api as never} workspaceId="ws1" toast={toast as never} canManage={false} />)
    expect(await screen.findByText('HUMAN APPROVAL')).toBeInTheDocument()
    expect(screen.getByText(/switched off for this ACAOS deployment/)).toBeInTheDocument()
    expect(screen.getByText(/not opted in/)).toBeInTheDocument()
    expect(screen.getByText(/Reviewed drafts \(90 days\): 3 of 20 needed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Opt in/ })).toBeNull()
  })

  test('an admin opts in by naming the consent version shown', async () => {
    const api = vi.fn((path: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'PATCH' ? status({ optedIn: true, optInAt: '2026-10-10T00:00:00Z', blockers: ['MODE_OFF'] }) : status()))
    render(<AutonomySection api={api as never} workspaceId="ws1" toast={toast as never} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Opt in to automatic sending' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/autonomy', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ optIn: true, consentVersion: '2026-10-10.v1' }),
    })))
    expect(await screen.findByRole('button', { name: 'Opt out of automatic sending' })).toBeInTheDocument()
  })
})
