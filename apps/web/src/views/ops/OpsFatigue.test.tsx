import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OpsFatigue } from './OpsFatigue.js'
import type { OpsCrewMember, OpsFatigueRisk, Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

const crew: OpsCrewMember[] = [
  { id: 'c1', employeeCode: 'E1', fullName: 'Jane Doe', role: 'Labourer', isActive: true } as OpsCrewMember,
]

const report: OpsFatigueRisk = {
  crewMemberId: 'c1',
  riskLevel: 'HIGH',
  riskScore: 45,
  factors: ['52 hours in the last 7 days'],
  totalHours7d: 52,
  avgHoursPerDay: 7.4,
  consecutiveDays: 5,
  consecutiveDaysCapped: false,
  lastShiftDate: '2026-09-10T00:00:00.000Z',
  recommendation: 'Limit to a single shift per day and enforce the minimum rest period between shifts before the next roster.',
}

function apiFor(reports: OpsFatigueRisk[]) {
  return vi.fn((path: string) => {
    if (path.startsWith('/api/ops/crew?')) return Promise.resolve({ crew })
    if (path.startsWith('/api/ops/fatigue?')) {
      const summary = {
        critical: reports.filter(r => r.riskLevel === 'CRITICAL').length,
        high: reports.filter(r => r.riskLevel === 'HIGH').length,
        medium: reports.filter(r => r.riskLevel === 'MEDIUM').length,
        low: reports.filter(r => r.riskLevel === 'LOW').length,
      }
      return Promise.resolve({ summary, reports })
    }
    return Promise.resolve({})
  })
}

afterEach(() => vi.restoreAllMocks())

describe('OpsFatigue', () => {
  test('renders risk-level counts and the per-crew-member table', async () => {
    const api = apiFor([report])
    render(<OpsFatigue api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(screen.getByText('45')).toBeInTheDocument()
    expect(screen.getByText('52')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText(/Limit to a single shift/i)).toBeInTheDocument()

    expect(screen.getByText('Critical')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/ops/fatigue?'))
  })

  test('shows the empty state when there are no reports', async () => {
    const api = apiFor([])
    render(<OpsFatigue api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(await screen.findByText(/No active crew members/i)).toBeInTheDocument()
  })
})
