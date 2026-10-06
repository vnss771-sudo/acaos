import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Today, needsAttention } from './Today.js'
import type { Workspace } from '../types.js'
import type { PilotScorecard } from '../lib/scorecard.js'
import { makeScorecard } from '../test/scorecardFixture.js'

const workspace: Workspace = { id: 'ws1', name: 'Sparky Co', slug: 'sparky', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const setView = vi.fn()
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
const old = new Date(Date.now() - 40 * 86_400_000).toISOString()

const base = {
  eventType: 'CAPACITY_EXPANSION', whyNow: 'Opened a new depot and hiring 17 technicians', confidence: 82, independentSources: 3,
  estimatedValueMinCents: null, estimatedValueMaxCents: null, probability: 0.3, priority: 80, buyingStage: 'ACTIVE_REQUIREMENT',
  actionLabel: 'Call the operations manager', actionReason: 'Corroborated expansion', recommendationKind: 'CONTACT_NOW',
  intelligenceGate: true, offer: { id: 'of1', name: 'Temporary field crews' },
}
const URGENT = { ...base, id: 'c1', eventTitle: 'New depot', urgency: 'HIGH', status: 'OPEN', expectedValueCents: 1_800_000, firstDetectedAt: recent, prospect: { id: 'p1', companyName: 'Northside Builders', domain: null } }
const PURSUING = { ...base, id: 'c2', eventTitle: 'Tender won', urgency: 'MEDIUM', status: 'PURSUING', expectedValueCents: 1_200_000, firstDetectedAt: old, prospect: { id: 'p2', companyName: 'Harbour Civil', domain: null } }
const WATCH = { ...base, id: 'c3', eventTitle: 'Hiring', urgency: 'LOW', status: 'OPEN', expectedValueCents: null, firstDetectedAt: old, intelligenceGate: false, prospect: { id: 'p3', companyName: 'Ridge Electrical', domain: null } }
const SUMMARY = { opportunities: 3, reached: { QUOTED: 4 }, conversion: { quotedToWon: 0.5, sentToReplied: 0.2 }, wonRevenueCents: { sourced: 5_000_000, influenced: 1_000_000 } }
const DETAIL = {
  ...URGENT, reasons: [], blockers: [],
  recommendation: { label: 'Contact now', headline: 'Call now: the depot opens next month', why: ['Three independent sources'], citations: [{ claim: 'Hiring 17 field technicians', source: 'jobs.example.com', sourceUrl: 'https://jobs.example.com/1', eventDate: recent, ageDays: 2, quality: 80 }], outreach: true, nextSteps: [] },
  prospect: { ...URGENT.prospect, contactName: 'Sam Lee', contactTitle: 'Ops Manager', contactEmail: 'sam@example.test' },
}

function mockApi(opts: { networkIn?: boolean; quotes?: unknown[]; scorecard?: PilotScorecard } = {}) {
  return vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method && init.method !== 'GET') return Promise.resolve({ ok: true, created: true, intentId: 'i1', success: true, optedInAt: null })
    if (path.startsWith('/api/commercial-opportunities/outcomes')) return Promise.resolve({ summary: SUMMARY })
    if (path.startsWith('/api/commercial-opportunities/network-benchmarks')) return Promise.reject(new Error('Today reads the opt-in state, not the benchmarks'))
    if (path.startsWith('/api/commercial-opportunities/network-participation')) return Promise.resolve({ optedInAt: opts.networkIn ? '2026-09-01T00:00:00.000Z' : null })
    if (path.startsWith('/api/commercial-opportunities/c1')) return Promise.resolve({ opportunity: DETAIL })
    if (path.startsWith('/api/commercial-opportunities')) return Promise.resolve({ opportunities: [URGENT, PURSUING, WATCH] })
    if (path.startsWith('/api/delivery/report')) return Promise.resolve({ report: { minJobs: 3, overall: { jobs: 4, grossMarginPct: { n: 4, median: 24 }, labourMarginPct: null } } })
    if (path.startsWith('/api/delivery/quotes')) return Promise.resolve({ quotes: opts.quotes ?? [] })
    if (path.startsWith('/api/delivery/scorecard') && opts.scorecard) return Promise.resolve({ scorecard: opts.scorecard })
    return Promise.reject(new Error(`unexpected ${path}`))
  })
}
const writes = (api: ReturnType<typeof vi.fn>) => api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method && (init as { method: string }).method !== 'GET')

beforeEach(() => vi.clearAllMocks())

describe('Today', () => {
  test('admins see this week in Find work, with the margin and best source, linked to the scorecard', async () => {
    render(<Today api={mockApi({ scorecard: makeScorecard() }) as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    expect(await screen.findByText('This week in Find work')).toBeInTheDocument()
    expect(screen.getByText('7 found · 3 worth pursuing · 2 quotes ($42,000) · 1 won ($18,500)')).toBeInTheDocument()
    expect(screen.getByText('31% gross margin (1 closed job) · Best source: Development applications')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open scorecard' }))
    expect(setView).toHaveBeenCalledWith('ops-scorecard')
  })

  test('no Find work card for members, or for a workspace without Find work', async () => {
    const memberApi = mockApi({ scorecard: makeScorecard() })
    const { unmount } = render(<Today api={memberApi as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(await screen.findByText('Needs your decision (2)')).toBeInTheDocument()
    expect(memberApi.mock.calls.some(([p]) => String(p).startsWith('/api/delivery/scorecard'))).toBe(false)
    unmount()

    const outreachOnly = makeScorecard({ findWorkSetUp: false, totals: { ...makeScorecard().totals, found: 0 } })
    render(<Today api={mockApi({ scorecard: outreachOnly }) as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    expect(await screen.findByText('Needs your decision (2)')).toBeInTheDocument()
    expect(screen.queryByText('This week in Find work')).not.toBeInTheDocument()
  })

  test('needsAttention: pursued work and high-urgency open work', () => {
    expect(needsAttention(URGENT as never)).toBe(true)
    expect(needsAttention(PURSUING as never)).toBe(true)
    expect(needsAttention(WATCH as never)).toBe(false)
  })

  test('splits decisions from watching, shows new work and the KPIs with what they rest on', async () => {
    render(<Today api={mockApi() as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    expect(await screen.findByText('Needs your decision (2)')).toBeInTheDocument()
    expect(screen.getByText('Worth watching (1)')).toBeInTheDocument()
    expect(screen.getByText('New this week (1)')).toBeInTheDocument()
    expect(screen.getByText('$30,000')).toBeInTheDocument()
    expect(screen.getByText('$60,000')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('24%')).toBeInTheDocument()
    expect(screen.getByText('median gross, 4 closed jobs')).toBeInTheDocument()
    expect(screen.getByText('Unconfirmed')).toBeInTheDocument()
    expect(screen.getByText('value unknown')).toBeInTheDocument()
  })

  // Find work quotes live on Opportunity, which the outcomes summary never sees.
  // A contractor who quoted and won through Find work used to see $0 and "0 quoted".
  test('Find work quotes and wins count toward won revenue, quote-to-win and the pipeline hint', async () => {
    const fw = (id: string, opportunityId: string, status: string, amountCents: number) =>
      ({ id, opportunityId, commercialOpportunityId: null, status, amountCents, estimatedHours: 100, job: null })
    const quotes = [
      fw('q3', 'o1', 'ACCEPTED', 6_000_000),
      fw('q2', 'o2', 'ACCEPTED', 2_500_000),
      fw('q1', 'o3', 'SUBMITTED', 1_000_000),
      fw('q0', 'o3', 'DRAFT', 900_000), // older draft of o3: superseded, never counted
    ]
    render(<Today api={mockApi({ quotes }) as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    expect(await screen.findByText('Needs your decision (2)')).toBeInTheDocument()
    // Summary: $50,000 sourced + $10,000 influenced, plus $85,000 accepted in Find work.
    expect(screen.getByText('$145,000')).toBeInTheDocument()
    expect(screen.getByText('$50,000 sourced · $10,000 influenced · $85,000 from Find work')).toBeInTheDocument()
    // Summary: 2 of 4 quoted won; Find work: 2 of 3 quoted won → 4 of 7.
    expect(screen.getByText('57%')).toBeInTheDocument()
    expect(screen.getByText('7 quoted')).toBeInTheDocument()
    expect(screen.getByText('3 opportunities, value × chance · $10,000 quoted in Find work')).toBeInTheDocument()
  })

  test('members see no margin, quotes or network controls, and those endpoints are never called', async () => {
    const api = mockApi()
    render(<Today api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    expect(await screen.findByText('Needs your decision (2)')).toBeInTheDocument()
    expect(screen.queryByText('Delivered margin')).toBeNull()
    expect(screen.queryByText('Opt in')).toBeNull()
    expect(api.mock.calls.some(([p]) => String(p).includes('/api/delivery') || String(p).includes('/network-'))).toBe(false)
  })

  test('evidence opens with citations and contact; admins can propose outreach', async () => {
    const api = mockApi()
    render(<Today api={api as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Why? Show evidence' }))[0])
    expect(await screen.findByText('Call now: the depot opens next month')).toBeInTheDocument()
    expect(screen.getByText(/Hiring 17 field technicians/)).toBeInTheDocument()
    expect(screen.getByText('sam@example.test')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Propose outreach' }))
    const [path, init] = writes(api)[0]
    expect(path).toBe('/api/commercial-opportunities/c1/intent')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1' })
  })

  test('pursue sends the status; pursued work offers a quote to admins', async () => {
    const api = mockApi()
    render(<Today api={api as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Pursue' }))[0])
    const [path, init] = writes(api)[0]
    expect(path).toBe('/api/commercial-opportunities/c1/status')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1', status: 'PURSUING' })
    expect(screen.getByRole('button', { name: 'Record quote' })).toBeInTheDocument()
  })

  test('network: not opted in offers opt-in; opting in sends the choice', async () => {
    const api = mockApi()
    render(<Today api={api as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Opt in' }))
    const [path, init] = writes(api)[0]
    expect(path).toBe('/api/commercial-opportunities/network-participation')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws1', optIn: true })
    expect(await screen.findByRole('button', { name: 'Stop sharing' })).toBeInTheDocument()
  })

  test('network: the opt-in state is read directly, never by probing the benchmarks', async () => {
    const api = mockApi({ networkIn: true })
    render(<Today api={api as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    expect(await screen.findByRole('button', { name: 'Stop sharing' })).toBeInTheDocument()
    expect(api.mock.calls.some(([p]) => String(p).includes('network-benchmarks'))).toBe(false)
  })
})

describe('Today — won work', () => {
  test('a won opportunity with an accepted quote waits under "Won — start the job" and starts from there', async () => {
    const WON = { ...URGENT, id: 'c9', status: 'WON', urgency: 'MEDIUM', prospect: { id: 'p9', companyName: 'Apex Aged Care', domain: null } }
    const api = vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method && init.method !== 'GET') return Promise.resolve({ job: { id: 'j1' } })
      if (path.startsWith('/api/delivery/quotes')) return Promise.resolve({ quotes: [{ id: 'q9', opportunityId: null, commercialOpportunityId: 'c9', status: 'ACCEPTED', amountCents: 6_800_000, estimatedHours: 380, job: null }] })
      if (path.startsWith('/api/commercial-opportunities') && !path.includes('/outcomes') && !path.includes('network')) return Promise.resolve({ opportunities: [WON] })
      return mockApi()(path, init)
    })
    render(<Today api={api as never} workspace={workspace} toast={toast as never} isAdmin setView={setView} />)
    expect(await screen.findByText('Won — start the job (1)')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start the job' }))
    expect(writes(api)[0][0]).toBe('/api/delivery/quotes/q9/job')
    await vi.waitFor(() => expect(setView).toHaveBeenCalledWith('ops-delivery'))
  })
})

describe('Today — untrusted evidence links', () => {
  test('a javascript: source URL is never rendered as a link', async () => {
    const api = mockApi()
    const evil = { ...DETAIL, recommendation: { ...DETAIL.recommendation, citations: [{ ...DETAIL.recommendation.citations[0], sourceUrl: 'javascript:alert(1)' }] } }
    api.mockImplementation((path: string, init?: { method?: string }) =>
      path.startsWith('/api/commercial-opportunities/c1') && !init?.method ? Promise.resolve({ opportunity: evil }) : mockApi()(path, init))
    render(<Today api={api as never} workspace={workspace} toast={toast as never} setView={setView} />)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Why? Show evidence' }))[0])
    expect(await screen.findByText(/Hiring 17 field technicians/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'source ↗' })).toBeNull()
  })
})
