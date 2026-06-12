import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Intelligence } from './Intelligence.js'
import type { Workspace, OpportunitiesData, ForecastData } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const opportunities: OpportunitiesData = {
  hot: [], warm: [], cold: [], totals: { hot: 23, warm: 51, cold: 74, total: 148 },
}
const forecast: ForecastData = {
  summary: { totalProspects: 148, totalPipelineValue: 1_000_000, weightedForecast: 486_000, wonRevenue: 1_840_000, wonCount: 8, avgDealValue: 10_000, avgWinRate: 0.6 },
  stageBreakdown: { PURCHASING: { count: 15, forecast: 200_000 } },
  pipeline: [],
}

function apiFor() {
  return vi.fn((path: string) => {
    if (path.includes('/opportunities')) return Promise.resolve(opportunities)
    if (path.includes('/forecast')) return Promise.resolve(forecast)
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('Intelligence', () => {
  test('shows an empty state when no workspace is selected', () => {
    render(<Intelligence api={vi.fn() as never} workspace={null} toast={toast as never} setView={vi.fn()} />)
    expect(screen.getByText('No workspace selected')).toBeInTheDocument()
  })

  test('loads opportunities + forecast and renders the KPI bar', async () => {
    const api = apiFor()
    render(<Intelligence api={api as never} workspace={workspace} toast={toast as never} setView={vi.fn()} />)

    expect(await screen.findByText('148')).toBeInTheDocument()        // total prospects
    expect(screen.getByText('23')).toBeInTheDocument()                // hot
    expect(screen.getByText('$486,000')).toBeInTheDocument()          // weighted forecast
    expect(api).toHaveBeenCalledWith('/api/intelligence/opportunities?workspaceId=ws1')
    expect(api).toHaveBeenCalledWith('/api/intelligence/forecast?workspaceId=ws1')
  })

  test('switching to the Revenue Forecast tab shows the forecast panel', async () => {
    const api = apiFor()
    render(<Intelligence api={api as never} workspace={workspace} toast={toast as never} setView={vi.fn()} />)
    await screen.findByText('148') // wait for load

    await userEvent.click(screen.getByRole('button', { name: 'Revenue Forecast' }))
    expect(await screen.findByText('Won Revenue')).toBeInTheDocument()
    expect(screen.getByText('$1,840,000')).toBeInTheDocument()
  })
})
