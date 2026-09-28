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
  evidence: { totalOutcomes: 40, baselineWinRate: 0.2, industries: [{ segment: 'electrical', won: 8, total: 12, observedWinRate: 0.667, adjustedWinRate: 0.49, lift: 2.45 }] },
}
const applied = { ...base, id: 'r2', type: 'ICP_SIZE', status: 'APPROVED', decidedAt: '2026-09-02T00:00:00Z', currentValue: {}, proposedValue: { minEmployees: 20, maxEmployees: 80 }, evidence: {} }
const expired = { ...pending, id: 'r3', expired: true }

function apiWith(recs: unknown[]) {
  return vi.fn((path: string, _init?: unknown) =>
    path.endsWith('/learning-recommendations') ? Promise.resolve({ recommendations: recs }) : Promise.resolve({ recommendation: {} }))
}

describe('LearningSection', () => {
  test('shows a pending proposal in plain language, with evidence on request', async () => {
    render(<LearningSection api={apiWith([pending]) as never} workspaceId="ws1" toast={toast as never} canManage />)
    expect(await screen.findByText('Focus on the industries that are converting best')).toBeInTheDocument()
    expect(screen.getByText('Now: HVAC')).toBeInTheDocument()
    expect(screen.getByText('Suggested: electrical')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Review evidence' }))
    expect(screen.getByText('2.45×')).toBeInTheDocument()
    expect(screen.getByText(/not proof of cause/)).toBeInTheDocument()
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
})
