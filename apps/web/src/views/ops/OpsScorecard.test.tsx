import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsScorecard } from './OpsScorecard.js'
import type { Workspace } from '../../types.js'
import { makeScorecard } from '../../test/scorecardFixture.js'

const workspace: Workspace = { id: 'ws1', name: 'Sparky Co', slug: 'sparky', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

beforeEach(() => vi.clearAllMocks())

describe('OpsScorecard', () => {
  test('non-admins see no figures and no request is made', () => {
    const api = vi.fn()
    render(<OpsScorecard api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(screen.getByText('Admins only')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  test('shows this week, the targets, the source table and the insight', async () => {
    const api = vi.fn().mockResolvedValue({ scorecard: makeScorecard() })
    render(<OpsScorecard api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText('7 found · 3 worth pursuing · 2 quotes ($42,000) · 1 won ($18,500)')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/delivery/scorecard?workspaceId=ws1')
    expect(screen.getByText('31% gross margin (1 closed job) · Best source: Development applications')).toBeInTheDocument()
    expect(screen.getByText(/You made the most money from development applications/)).toBeInTheDocument()
    // Targets: found and quotes on target this week; close-out at 1 of 2 is below 80%.
    expect(screen.getAllByText('On target').length).toBe(3)
    expect(screen.getByText('Below target')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 (50%)')).toBeInTheDocument()
    expect(screen.getByText('1 in progress')).toBeInTheDocument()
    expect(screen.getByText('Development applications ($12,400 gross margin)')).toBeInTheDocument()
    expect(screen.getByText('Contract awards')).toBeInTheDocument()
    expect(screen.getByText('$12,400 (31%)')).toBeInTheDocument()
    // Quote → won uses Today's definition: won over everything quoted.
    expect(screen.getByText('Found → quoted: 33% (3 of 9) · Quote → won: 33% (1 of 3, 1 lost, 1 awaiting a decision)')).toBeInTheDocument()
  })

  test('before any closed job, the source target is not yet met and says what it needs', async () => {
    const sc = makeScorecard({
      margin: { closedJobs: 0, grossMarginJobs: 0, grossMarginCents: null, revenueCents: null, grossMarginPct: null },
      bestSource: null,
      checks: { thisWeek: { found: false, quotes: false }, weeksMet: { found: 0, quotes: 0, of: 2 }, closeout: null, sourceIdentified: false },
    })
    render(<OpsScorecard api={vi.fn().mockResolvedValue({ scorecard: sc }) as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText('Needs a closed-out job with its costs entered')).toBeInTheDocument()
    expect(screen.getAllByText('Below target').length).toBe(2)
    expect(screen.getAllByText('Not yet').length).toBe(2)
  })

  test('the week table links back to Find work', async () => {
    render(<OpsScorecard api={vi.fn().mockResolvedValue({ scorecard: makeScorecard() }) as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open Find work' }))
    expect(setView).toHaveBeenCalledWith('ops-find-work')
  })

  test('a failed load offers a retry', async () => {
    const api = vi.fn().mockRejectedValue(new Error('boom'))
    render(<OpsScorecard api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText('Failed to load the scorecard.')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith('boom')
  })
})
