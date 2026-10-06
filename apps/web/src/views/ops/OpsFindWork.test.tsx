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

function mockApi(opts: { profile?: unknown; opportunities?: unknown[]; enabled?: boolean; quotes?: unknown[] } = {}) {
  return vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
    if (path.startsWith('/api/delivery/quotes') && !init?.method) return Promise.resolve({ quotes: opts.quotes ?? [] })
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
    // The default "Active" tab asks for new + pursuing only, matching its count.
    expect(api).toHaveBeenCalledWith('/api/opportunities?workspaceId=ws1&scope=active')
  })

  test('without a profile, admins are asked to set it up', async () => {
    const api = mockApi({ profile: null, opportunities: [] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    expect(await screen.findByText('Tell us what work you want')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up Find work' })).toBeInTheDocument()
  })

  test('Pursue → Won it → Start the job walk the workflow', async () => {
    const api = mockApi()
    const { unmount } = render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pursue' }))
    await waitFor(() => expect(posts(api)).toHaveLength(1))
    expect(posts(api)[0][0]).toBe('/api/opportunities/o1/status')
    expect(JSON.parse((posts(api)[0][1] as { body: string }).body)).toEqual({ workspaceId: 'ws1', status: 'PURSUING' })

    unmount()
    const wonApi = mockApi({ opportunities: [{ ...OPP, status: 'WON' }] })
    render(<OpsFindWork api={wonApi as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Start the job' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Job OPP-ABC123 started — add your crew and log shifts against it'))
  })

  test('members cannot create job sites or change settings', async () => {
    const api = mockApi({ opportunities: [{ ...OPP, status: 'WON' }] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    await screen.findByText('Electrical maintenance — Brisbane office')
    expect(screen.queryByRole('button', { name: 'Start the job' })).not.toBeInTheDocument()
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

  test('with searching switched off, Search now is disabled and the empty list says why', async () => {
    const api = mockApi({ enabled: false, opportunities: [] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} canManage />)
    expect(await screen.findByText(/once automatic searching is turned on/)).toBeInTheDocument()
    expect(screen.queryByText(/We search on a schedule/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search now' })).toBeDisabled()
  })

  test('admins record a quote on work they are pursuing (cents, straight to submitted)', async () => {
    const api = mockApi({ opportunities: [{ ...OPP, status: 'PURSUING' }] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Record quote' }))
    await userEvent.type(screen.getByLabelText(/Quote amount/), '60,000')
    await userEvent.type(screen.getByLabelText(/Estimated labour hours/), '400')
    await userEvent.click(screen.getByRole('button', { name: 'Save quote' }))
    const [path, init] = posts(api)[0]
    expect(path).toBe('/api/delivery/quotes')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1', opportunityId: 'o1', amountCents: 6_000_000, estimatedHours: 400, submit: true })
  })

  test('a submitted quote shows its figures and can be accepted', async () => {
    const api = mockApi({
      opportunities: [{ ...OPP, status: 'PURSUING' }],
      quotes: [{ id: 'q1', opportunityId: 'o1', status: 'SUBMITTED', amountCents: 6_000_000, estimatedHours: 400 }],
    })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    expect(await screen.findByText('$60,000')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Client accepted' }))
    const [path, init] = posts(api)[0]
    expect(path).toBe('/api/delivery/quotes/q1/status')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1', status: 'ACCEPTED' })
  })

  test('members never load or see quotes', async () => {
    const api = mockApi({ opportunities: [{ ...OPP, status: 'PURSUING' }] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(await screen.findByText('Electrical maintenance — Brisbane office')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record quote' })).toBeNull()
    expect(api.mock.calls.some(([p]) => String(p).startsWith('/api/delivery'))).toBe(false)
  })

  test('accepting a quote follows the won card to the Won tab, where the job is started from the quote', async () => {
    const quotes = [{ id: 'q1', opportunityId: 'o1', status: 'SUBMITTED', amountCents: 6_000_000, estimatedHours: 400, job: null }]
    const api = mockApi({ opportunities: [{ ...OPP, status: 'PURSUING' }], quotes })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Client accepted' }))
    await waitFor(() => expect(api.mock.calls.some(([p]) => String(p).includes('status=WON'))).toBe(true))
  })

  test('an accepted quote offers Start the job (from the quote), then Open job', async () => {
    const accepted = { id: 'q1', opportunityId: 'o1', status: 'ACCEPTED', amountCents: 6_000_000, estimatedHours: 400, job: null }
    const api = mockApi({ opportunities: [{ ...OPP, status: 'WON' }], quotes: [accepted] })
    render(<OpsFindWork api={api as never} workspace={workspace} toast={toast as never} canManage setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Start the job' }))
    await waitFor(() => expect(posts(api).some(([p]) => p === '/api/delivery/quotes/q1/job')).toBe(true))
    expect(setView).toHaveBeenCalledWith('ops-delivery')
  })
})
