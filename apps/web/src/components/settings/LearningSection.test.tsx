import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LearningSection } from './LearningSection.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

const base = { workspaceId: 'ws1', sampleSize: 40, mode: 'shadow', createdAt: '2026-09-01T00:00:00Z', decidedBy: null }
const pending = {
  ...base, id: 'r1', type: 'ICP_INDUSTRY', status: 'PENDING', decidedAt: null, expired: false,
  currentValue: ['HVAC'], proposedValue: ['electrical'],
  evidence: { totalOutcomes: 40, baselineWinRate: 0.2, confidence: 'Medium', recencyHalfLifeDays: 180, calibrationVersion: 1, industries: [{ segment: 'electrical', won: 8, total: 12, observedWinRate: 0.667, adjustedWinRate: 0.49, lift: 2.45 }] },
}
const applied = { ...base, id: 'r2', type: 'ICP_SIZE', status: 'APPROVED', decidedAt: '2026-09-02T00:00:00Z', currentValue: {}, proposedValue: { minEmployees: 20, maxEmployees: 80 }, evidence: {} }
const expired = { ...pending, id: 'r3', expired: true }
const advisory = {
  ...base, id: 'r4', type: 'OPPORTUNITY_CAUSE', status: 'PENDING', decidedAt: null, expired: false, currentValue: null,
  proposedValue: { findings: [
    { cause: 'WRONG_TIMING', dimension: 'eventType', value: 'HIRING_SURGE', advice: 'Wait for an active requirement and fresher evidence before contacting on these' },
    { cause: 'WRONG_CONTACT', dimension: 'offerKey', value: 'offer:crews', advice: 'Verify the decision maker before outreach on these' },
  ] },
  evidence: { basis: '2 repeated causes across 10 closed or stalled opportunities', attributed: 10 },
}
const acknowledged = { ...advisory, id: 'r5', status: 'APPROVED', decidedAt: '2026-09-02T00:00:00Z' }

function apiWith(recs: unknown[]) {
  return vi.fn((path: string, _init?: unknown) =>
    path.endsWith('/learning-recommendations') ? Promise.resolve({ recommendations: recs }) : Promise.resolve({ recommendation: {} }))
}

describe('LearningSection', () => {
  // UQ-29: event-weight proposals carry a held-out verdict; only IMPROVED can be accepted.
  const weights = (id: string, heldOut?: Record<string, unknown>) => ({
    ...base, id, type: 'EVENT_KIND_WEIGHT', status: 'PENDING', decidedAt: null, expired: false,
    currentValue: {}, proposedValue: { CAPACITY_EXPANSION: 1.3 },
    evidence: { totalOutcomes: 32, baselineWinRate: 0.5, ...(heldOut ? { heldOut } : {}) },
  })

  test('an event-weight proposal that beat the current weights on held-back outcomes can be accepted', async () => {
    const api = apiWith([weights('w1', { verdict: 'IMPROVED', reason: 'x', holdoutSize: 10, brierImprovement: 0.031, aucDelta: 0.05 })])
    render(<LearningSection api={api as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findByText(/Tested on the 10 newest outcomes: beat the current weights \(error reduced by \+0\.031, ranking \+0\.050\)/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/learning-recommendations/w1/approve', expect.objectContaining({ method: 'POST' })))
  })

  test('an untested or non-improving event-weight proposal cannot be accepted', async () => {
    const recs = [
      weights('w2', { verdict: 'DEGRADED', reason: 'x', holdoutSize: 10, brierImprovement: -0.02, aucDelta: -0.1 }),
      weights('w3'),
    ]
    render(<LearningSection api={apiWith(recs) as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findByText(/did worse than the current weights/)).toBeInTheDocument()
    expect(screen.getByText(/Not yet tested on held-back outcomes/)).toBeInTheDocument()
    for (const b of screen.getAllByRole('button', { name: 'Accept' })) expect(b).toBeDisabled()
  })

  test('shows a pending proposal in plain language, with evidence on request', async () => {
    render(<LearningSection api={apiWith([pending]) as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findByText('Focus on the industries that are converting best')).toBeInTheDocument()
    expect(screen.getByText('Now: HVAC')).toBeInTheDocument()
    expect(screen.getByText('Suggested: electrical')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Review evidence' }))
    expect(screen.getByText('2.45×')).toBeInTheDocument()
    expect(screen.getByText(/not proof of cause/)).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText(/half-weight after 180 days/)).toBeInTheDocument()
    expect(screen.getByText(/method v1/)).toBeInTheDocument()
  })

  test('Accept posts the approve route for that recommendation', async () => {
    const api = apiWith([pending])
    render(<LearningSection api={api as never} workspaceId="ws1" toast={toast as never} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/learning-recommendations/r1/approve', expect.objectContaining({ method: 'POST' })))
    expect(toast.success).toHaveBeenCalled()
  })

  test('members without edit rights can review but not decide or revert', async () => {
    render(<LearningSection api={apiWith([pending, applied]) as never} workspaceId="ws1" toast={toast as never} canManage={false} />)
    await screen.findByText('Focus on the industries that are converting best')
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review evidence' })).toBeInTheDocument()
  })

  test('applied changes can be reverted; expired proposals are hidden', async () => {
    const api = apiWith([applied, expired])
    render(<LearningSection api={api as never} workspaceId="ws1" toast={toast as never} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/learning-recommendations/r2/revert', expect.objectContaining({ method: 'POST' })))
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  test('explains the cold start when there is nothing to suggest', async () => {
    render(<LearningSection api={apiWith([]) as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findByText(/at least 10 recorded wins\/losses/)).toBeInTheDocument()
  })

  test('advisory cause proposals read as advice, are acknowledged on Accept, and cannot be reverted', async () => {
    const api = apiWith([advisory, acknowledged])
    render(<LearningSection api={api as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findAllByText('Wait for an active requirement and fresher evidence before contacting on these (+1 more)')).not.toHaveLength(0)
    expect(screen.getAllByText(/Wrong timing for event HIRING_SURGE; Wrong contact for offer offer:crews/).length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByRole('button', { name: 'Review evidence' })[0])
    expect(screen.getByText('2 repeated causes across 10 closed or stalled opportunities')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/learning-recommendations/r4/approve', expect.objectContaining({ method: 'POST' })))
    expect(toast.success).toHaveBeenCalledWith('Noted')
  })

  test('event-kind weight proposals show what would change, and can be reverted once accepted', async () => {
    const weights = {
      ...base, id: 'r6', type: 'EVENT_KIND_WEIGHT', status: 'PENDING', decidedAt: null, expired: false,
      currentValue: { HIRING_SURGE: 0.8 }, proposedValue: { HIRING_SURGE: 0.8, TENDER_OPPORTUNITY: 1.3 }, evidence: {},
    }
    const accepted = { ...weights, id: 'r7', status: 'APPROVED', decidedAt: '2026-09-02T00:00:00Z' }
    const api = apiWith([weights, accepted])
    render(<LearningSection api={api as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findByText('Weight commercial events by how often they turned into wins')).toBeInTheDocument()
    expect(screen.getByText(/tender opportunity ×1\.3/)).toBeInTheDocument()
    expect(screen.getByText(/1 calibrated event/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/learning-recommendations/r7/revert', expect.objectContaining({ method: 'POST' })))
  })
})
