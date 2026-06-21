import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { computeNextBestAction, NextBestActionCard } from './NextBestAction.js'
import type { StatsData } from '../types.js'

function statsWith(over: Partial<StatsData> = {}): StatsData {
  return {
    totalLeads: 50,
    campaignCount: 2,
    funnel: {},
    metrics: { replyRate: 0, bookingRate: 0, closeRate: 0, contacted: 0, replied: 0, booked: 0, closed: 0 },
    recentLeads: [],
    topLeads: [],
    scoreDistribution: { HOT: 0, WARM: 0, COLD: 0 },
    scoringModel: null,
    usage: { month: '2026-06', totals: { AI_RESEARCH: 0, AI_OUTREACH: 0, AI_REPLY: 0 }, total: 0, limit: 15, plan: 'free', maxLeads: -1 },
    ...over,
  } as StatsData
}

describe('computeNextBestAction', () => {
  test('prompts discovery when there are no prospects', () => {
    expect(computeNextBestAction({ stats: statsWith({ totalLeads: 0 }), hotCount: 0, signalCount: 0 }).view).toBe('prospects')
    // Also when stats have not loaded yet.
    expect(computeNextBestAction({ stats: null, hotCount: 0, signalCount: 0 }).id).toBe('discover')
  })

  test('prompts a first mission when prospects exist but no campaigns', () => {
    const nba = computeNextBestAction({ stats: statsWith({ totalLeads: 10, campaignCount: 0 }), hotCount: 0, signalCount: 0 })
    expect(nba.id).toBe('mission')
    expect(nba.view).toBe('missions')
  })

  test('replies take priority over hot accounts and signals', () => {
    const nba = computeNextBestAction({ stats: statsWith({ funnel: { REPLIED: 3 } }), hotCount: 5, signalCount: 9 })
    expect(nba.id).toBe('replies')
    expect(nba.title).toMatch(/3 replies waiting/i)
    expect(nba.view).toBe('leads')
  })

  test('falls back to hot accounts, then signals, then momentum', () => {
    expect(computeNextBestAction({ stats: statsWith(), hotCount: 2, signalCount: 4 }).id).toBe('hot')
    expect(computeNextBestAction({ stats: statsWith(), hotCount: 0, signalCount: 4 }).id).toBe('signals')
    expect(computeNextBestAction({ stats: statsWith(), hotCount: 0, signalCount: 0 }).id).toBe('momentum')
  })
})

describe('NextBestActionCard', () => {
  test('renders the action and routes on click', async () => {
    const setView = vi.fn()
    render(<NextBestActionCard stats={statsWith({ funnel: { REPLIED: 1 } })} hotCount={0} signalCount={0} setView={setView} />)
    expect(screen.getByText('Next best action')).toBeInTheDocument()
    expect(screen.getByText(/1 reply waiting/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Review replies/i }))
    expect(setView).toHaveBeenCalledWith('leads')
  })
})
