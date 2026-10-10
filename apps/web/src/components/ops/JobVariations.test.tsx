import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JobVariations, type JobVariation } from './JobVariations.js'
import { makeRouteApi } from '../../lib/routeApi.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

const v = (over: Partial<JobVariation>): JobVariation => ({
  id: 'v1', title: 'Extra sub-board', description: null, revenueCents: 500_000, estimatedCostCents: 200_000, estimatedHours: 20,
  status: 'SUBMITTED', submittedAt: null, decidedAt: null, createdAt: '2026-10-01T00:00:00Z', ...over,
})

describe('JobVariations', () => {
  test('a submitted variation can be approved; the price change is shown signed', async () => {
    const api = vi.fn(() => Promise.resolve({ variation: {} }))
    const onChanged = vi.fn()
    render(<JobVariations jobId="j1" jobActive variations={[v({}), v({ id: 'v2', title: 'Client supplies fittings', revenueCents: -100_000, status: 'APPROVED' })]}
      workspaceId="ws1" route={makeRouteApi(api as never)} toast={toast as never} onChanged={onChanged} isMobile={false} />)
    expect(screen.getByText(/1 awaiting approval/)).toBeInTheDocument()
    expect(screen.getByText(/^\+\$5,000/)).toBeInTheDocument()
    expect(screen.getByText(/^-\$1,000/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/delivery/variations/v1/status', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ workspaceId: 'ws1', status: 'APPROVED' }),
    })))
    expect(onChanged).toHaveBeenCalled()
  })

  test('recording a scope reduction sends a negative price in cents', async () => {
    const api = vi.fn(() => Promise.resolve({ variation: {} }))
    render(<JobVariations jobId="j1" jobActive variations={[]} workspaceId="ws1" route={makeRouteApi(api as never)} toast={toast as never} onChanged={vi.fn()} isMobile={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Record a variation' }))
    await userEvent.type(screen.getByLabelText('What changed'), 'Drop the second circuit')
    await userEvent.type(screen.getByLabelText('Price change ($)'), '-1,200')
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/delivery/jobs/j1/variations', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ workspaceId: 'ws1', title: 'Drop the second circuit', revenueCents: -120000, estimatedCostCents: null, estimatedHours: null, submit: true }),
    })))
  })

  test('a closed job shows its variations read-only', () => {
    render(<JobVariations jobId="j1" jobActive={false} variations={[v({})]} workspaceId="ws1" route={makeRouteApi(vi.fn() as never)} toast={toast as never} onChanged={vi.fn()} isMobile={false} />)
    expect(screen.getByText('Extra sub-board')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
