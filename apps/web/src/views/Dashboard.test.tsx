import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard } from './Dashboard.js'
import type { StatsData, Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }

const stats: StatsData = {
  totalLeads: 142,
  campaignCount: 5,
  funnel: { NEW: 40, CONTACTED: 30, REPLIED: 12, BOOKED: 6, CLOSED: 3 },
  metrics: { replyRate: 18.7, bookingRate: 9, closeRate: 4, contacted: 64, replied: 12, booked: 6, closed: 3 },
  recentLeads: [
    { id: 'l1', businessName: 'Meridian Roofing', stage: 'REPLIED', score: 84, category: 'Construction', createdAt: new Date().toISOString() },
  ],
  topLeads: [{ id: 'l2', businessName: 'Apex Plumbing', stage: 'NEW', score: 79, category: 'Field' }],
  scoreDistribution: { HOT: 23, WARM: 51, COLD: 68 },
  scoringModel: null,
  usage: { month: '2026-06', totals: { AI_RESEARCH: 5, AI_OUTREACH: 3, AI_REPLY: 1 }, total: 9, limit: 15, plan: 'free', maxLeads: -1 },
}

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

describe('Dashboard', () => {
  test('shows an empty state when no workspace is selected', () => {
    const api = vi.fn()
    render(<Dashboard api={api as never} workspace={null} setView={vi.fn()} toast={toast as never} />)
    expect(screen.getByText(/No workspace selected/i)).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  test('fetches stats for the workspace and renders the KPIs', async () => {
    const api = vi.fn().mockResolvedValue(stats)
    render(<Dashboard api={api as never} workspace={workspace} setView={vi.fn()} toast={toast as never} />)

    // Async: the numbers appear once the stats request resolves.
    expect(await screen.findByText('142')).toBeInTheDocument()        // total leads
    expect(screen.getByText('18.7%')).toBeInTheDocument()             // reply rate
    expect(screen.getByText('Meridian Roofing')).toBeInTheDocument()  // recent lead

    expect(api).toHaveBeenCalledWith('/api/stats?workspaceId=ws1')
  })

  test('renders the tier distribution section once loaded', async () => {
    const api = vi.fn().mockResolvedValue(stats)
    render(<Dashboard api={api as never} workspace={workspace} setView={vi.fn()} toast={toast as never} />)
    expect(await screen.findByText(/Lead Tier Distribution/i)).toBeInTheDocument()
  })

  test('shows a persistent error banner (not just a toast) when the stats load fails, and Retry reloads', async () => {
    const api = vi.fn().mockRejectedValue(new Error('Network error'))
    render(<Dashboard api={api as never} workspace={workspace} setView={vi.fn()} toast={toast as never} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to load dashboard data/i)
    expect(toast.error).toHaveBeenCalledWith('Network error')

    api.mockResolvedValue(stats)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('142')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
