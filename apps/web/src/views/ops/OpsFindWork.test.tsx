import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsFindWork } from './OpsFindWork.js'
import type { Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Sparky Co', slug: 'sparky', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()

const PROFILE_META = {
  discoveryEnabled: true,
  trades: [{ id: 'electrical', label: 'Electrical' }, { id: 'plumbing', label: 'Plumbing' }],
  regions: ['NSW', 'QLD'],
  sources: [
    { name: 'austender', label: 'AusTender contracts', description: 'Contracts just awarded', configured: true, lastRunAt: null, lastSuccessAt: null, lastError: null, lastWarning: null, lastMatched: 0 },
    { name: 'planningalerts', label: 'Council development applications', description: 'DAs near you', configured: false, lastRunAt: null, lastSuccessAt: null, lastError: null, lastWarning: null, lastMatched: 0 },
  ],
}
const PROFILE = { enabled: true, trades: ['electrical'], keywords: [], baseLat: -27.47, baseLng: 153.02, radiusKm: 50, regions: ['QLD'], minValue: null, sources: ['austender'] }

const OPP = {
  id: 'o1', source: 'austender', kind: 'CONTRACT_AWARD', title: 'Electrical maintenance — Brisbane office',
  description: null, address: null, locality: 'Brisbane', region: 'QLD', distanceKm: null, valueAmount: 425000,
  publishedAt: '2026-09-21T00:00:00Z', sourceUrl: 'https://example.test/cn/1', counterpartyName: 'Acme Builders',
  counterpartyAbn: '12345678901', counterpartyEmail: 'tenders@acme.test', counterpartyPhone: '07 5555 0000', buyerName: 'Dept of Example',
  score: 82, reasons: ['Classified as electrical work (“Electrical system services”)', 'Contract value $425k'],
  recommendedAction: 'Contact Acme Builders — they won this contract and may need electrical subcontractors.',
  status: 'NEW', opsJobSiteId: null,
}

function mockApi(opts: { profile?: unknown; opportunities?: unknown[]; enabled?: boolean } = {}) {
  return vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method && init.method !== 'GET') {
      if (path.endsWith('/create-job')) return Promise.resolve({ jobSite: { id: 'j1', jobCode: 'OPP-ABC123' } })
      return Promise.resolve({ success: true, profile: PROFILE, queued: true })
    }
    if (path.startsWith('/api/opportunities/profile')) {
      return Promise.resolve({ ...PROFILE_META, discoveryEnabled: opts.enabled ?? true, profile: 'profile' in opts ? opts.profile : PROFILE })
    }
    const opportunities = opts.opportunities ?? [OPP]
    return Promise.resolve({ opportunities, counts: { NEW: opportunities.length }, total: opportunities.length })
  })
}

function posts(api: ReturnType<typeof vi.fn>) {
  return api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method && (init as { method: string }).method !== 'GET')
}

beforeEach(() => vi.clearAllMocks())

describe('OpsFindWork', () => {
  test('shows each opportunity with its evidence, next step and contact', async () => {
    const api = mockApi()
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(await screen.findByText('Electrical maintenance — Brisbane office')).toBeInTheDocument()
    expect(screen.getByText('Contract awarded')).toBeInTheDocument()
    expect(screen.getByText('$425k')).toBeInTheDocument()
    expect(screen.getByText(/Classified as electrical work/)).toBeInTheDocument()
    expect(screen.getByText(/they won this contract and may need electrical subcontractors/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '07 5555 0000' })).toHaveAttribute('href', 'tel:0755550000')
    expect(screen.getByRole('link', { name: /View source/ })).toHaveAttribute('target', '_blank')
    expect(api).toHaveBeenCalledWith('/api/opportunities?workspaceId=ws1')
  })

  test('without a profile, admins are asked to set it up', async () => {
    const api = mockApi({ profile: null, opportunities: [] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    expect(await screen.findByText('Tell us what work you want')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up Find work' })).toBeInTheDocument()
  })

  test('Pursue → Won it → Create job site walk the workflow', async () => {
    const api = mockApi()
    const { unmount } = render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pursue' }))
    await waitFor(() => expect(posts(api)).toHaveLength(1))
    expect(posts(api)[0][0]).toBe('/api/opportunities/o1/status')
    expect(JSON.parse((posts(api)[0][1] as { body: string }).body)).toEqual({ workspaceId: 'ws1', status: 'PURSUING' })

    unmount()
    const wonApi = mockApi({ opportunities: [{ ...OPP, status: 'WON' }] })
    render(<OpsFindWork api={wonApi as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Create job site' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Job site OPP-ABC123 created'))
  })

  test('members cannot create job sites or change settings', async () => {
    const api = mockApi({ opportunities: [{ ...OPP, status: 'WON' }] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    await screen.findByText('Electrical maintenance — Brisbane office')
    expect(screen.queryByRole('button', { name: 'Create job site' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search now' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'What we look for' }))
    expect(screen.getByRole('checkbox', { name: 'Electrical' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  test('settings save the chosen trades, area and sources', async () => {
    const api = mockApi()
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Discovery settings' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Plumbing' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'NSW' }))
    await userEvent.type(screen.getByLabelText(/Extra keywords/), 'switchroom, x, cool room')
    await userEvent.clear(screen.getByLabelText(/Travel radius/))
    await userEvent.type(screen.getByLabelText(/Travel radius/), '80')
    expect(screen.getByText(/not set up on this server yet/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Discovery settings saved'))
    const [path, init] = posts(api)[0]
    expect(path).toBe('/api/opportunities/profile')
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      workspaceId: 'ws1', enabled: true, trades: ['electrical', 'plumbing'], keywords: ['switchroom', 'cool room'],
      baseLat: -27.47, baseLng: 153.02, radiusKm: 80, regions: ['QLD', 'NSW'], minValue: null, sources: ['austender'],
    })
  })

  test('warns when searching is switched off on the server', async () => {
    const api = mockApi({ enabled: false })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(await screen.findByText(/Automatic searching is switched off/)).toBeInTheDocument()
  })
})
