import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuoteCapture, quoteLifecycleCue, adjustedHours, SavedEstimateSummary, type EstimateCheck, type SavedEstimate } from './QuoteCapture'
import { makeRouteApi } from '../../lib/routeApi.js'

describe('quoteLifecycleCue', () => {
  test('follows persisted quote and job state only', () => {
    expect(quoteLifecycleCue({ status: 'SUBMITTED', job: null })).toBe('Opportunity → quote sent → awaiting decision')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: null })).toBe('Opportunity → quote → won → ready to start')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: { id: 'j1', status: 'ACTIVE' } })).toBe('Opportunity → quote → won → job in delivery')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: { id: 'j1', status: 'COMPLETE' } })).toBe('Opportunity → quote → won → job complete')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: { id: 'j1', status: 'CANCELLED' } })).toBe('Opportunity → quote → won → job cancelled')
  })

  test('has no cue for drafts or closed-out quotes', () => {
    for (const status of ['DRAFT', 'REJECTED', 'WITHDRAWN'] as const) expect(quoteLifecycleCue({ status, job: null })).toBeNull()
  })
})

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const OVER: EstimateCheck = {
  minJobs: 3, basis: 'SAME_ORIGIN', sameOriginJobs: 5, scopeChangedJobs: 1, direction: 'OVER', hoursFactor: 1.11,
  message: 'Development applications — your last 5 closed jobs took a median 11% more hours than estimated (4 of 5 ran over). Review the labour allowance before you send this quote.',
}

function renderForm(api: ReturnType<typeof vi.fn>, withApi = true) {
  render(<QuoteCapture route={makeRouteApi(api as never)} api={withApi ? api as never : undefined} toast={toast as never}
    workspaceId="ws1" target={{ opportunityId: 'o1' }} quote={null} onChanged={vi.fn()} />)
}

describe('QuoteCapture estimate check', () => {
  test('opening the form shows the track record and what the entered hours become', async () => {
    const api = vi.fn(() => Promise.resolve({ check: OVER }))
    renderForm(api)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    expect(api).toHaveBeenCalledWith('/api/delivery/estimate-check?workspaceId=ws1&opportunityId=o1')
    expect(await screen.findByText(/median 11% more hours than estimated/)).toBeInTheDocument()
    expect(screen.getByText(/1 job\(s\) with approved variations left out/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Estimated labour hours'), '400')
    expect(screen.getByRole('note', { name: 'Estimate check' })).toHaveTextContent('400 h is closer to 444 h')
  })

  test('advisory only: the quote saves the hours and amount as entered, never the adjusted figure', async () => {
    const api = vi.fn((path: string) => Promise.resolve(path.startsWith('/api/delivery/estimate-check') ? { check: OVER } : { quote: {} }))
    renderForm(api)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    await screen.findByText(/median 11% more hours/)
    await userEvent.type(screen.getByLabelText('Quote amount ($)'), '60000')
    await userEvent.type(screen.getByLabelText('Estimated labour hours'), '400')
    await userEvent.click(screen.getByRole('button', { name: 'Save quote' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/delivery/quotes', expect.objectContaining({ method: 'POST' })))
    const post = api.mock.calls.find(c => c[0] === '/api/delivery/quotes') as unknown as [string, { body: string }]
    expect(JSON.parse(post[1].body)).toEqual({ workspaceId: 'ws1', opportunityId: 'o1', amountCents: 6_000_000, estimatedHours: 400, submit: true })
  })

  test('below the floor it says how many closed jobs are still needed, with no figure', async () => {
    const api = vi.fn(() => Promise.resolve({ check: { ...OVER, basis: null, sameOriginJobs: 1, direction: null, hoursFactor: null, message: null } }))
    renderForm(api)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    expect(await screen.findByText(/1 of 3 closed jobs needed/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Estimated labour hours'), '400')
    expect(screen.queryByText(/is closer to/)).toBeNull()
  })

  test('a failed check never blocks the quote form', async () => {
    const api = vi.fn(() => Promise.reject(new Error('boom')))
    renderForm(api)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    expect(screen.getByRole('button', { name: 'Save quote' })).toBeEnabled()
    expect(screen.queryByRole('note', { name: 'Estimate check' })).toBeNull()
  })

  test('without a GET client no check is requested', async () => {
    const api = vi.fn()
    renderForm(api, false)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    expect(api).not.toHaveBeenCalled()
  })
})

describe('adjustedHours', () => {
  test('applies the factor only to a positive entered estimate', () => {
    expect(adjustedHours('400', { hoursFactor: 1.11 })).toBe(444)
    expect(adjustedHours('400', { hoursFactor: null })).toBeNull()
    for (const h of ['', '  ', 'abc', '0', '-5']) expect(adjustedHours(h, { hoursFactor: 1.1 })).toBeNull()
    expect(adjustedHours('400', null)).toBeNull()
  })
})

describe('saved estimate summary', () => {
  const SAVED: SavedEstimate = {
    version: 1, computedAt: '2026-10-17T09:00:00Z',
    result: {
      labourCostCents: 2_640_000, labourIncludesOnCosts: true, materialsCents: 1_500_000, subcontractCents: 0, overheadCents: 414_000,
      directCostCents: 4_140_000, priceCents: 6_000_000, grossMarginCents: 1_860_000, grossMarginPct: 31, marginAfterOverheadsCents: 1_446_000, marginAfterOverheadsPct: 24.1,
    },
  }

  test('shows the figures as saved; an entered zero is $0', () => {
    render(<SavedEstimateSummary estimate={SAVED} />)
    const region = screen.getByRole('region', { name: 'Saved estimate' })
    expect(region).toHaveTextContent('labour $26,400 · materials $15,000 · subcontractors $0 · overheads $4,140')
    expect(region).toHaveTextContent('At the quoted $60,000: gross profit $18,600 (31% gross margin) · after overheads $14,460 (24.1%)')
    expect(region).toHaveTextContent('Figures as saved, not recalculated.')
  })

  test('missing costs read "not entered", never $0, and an unknown profit says so', () => {
    const partial: SavedEstimate = { ...SAVED, result: { ...SAVED.result, materialsCents: null, overheadCents: null, directCostCents: null, grossMarginCents: null, grossMarginPct: null, marginAfterOverheadsCents: null, marginAfterOverheadsPct: null, labourIncludesOnCosts: false } }
    render(<SavedEstimateSummary estimate={partial} />)
    const region = screen.getByRole('region', { name: 'Saved estimate' })
    expect(region).toHaveTextContent('labour $26,400 (base pay only) · materials not entered · subcontractors $0 · overheads not entered')
    expect(region).toHaveTextContent('Gross profit unknown')
    expect(region).not.toHaveTextContent('gross profit $')
  })

  test('renders nothing for a quote without an estimate, or a snapshot it cannot read', () => {
    const { container } = render(<><SavedEstimateSummary estimate={null} /><SavedEstimateSummary estimate={undefined} /><SavedEstimateSummary estimate={{ version: 9 } as unknown as SavedEstimate} /></>)
    expect(container).toBeEmptyDOMElement()
  })

  test('a saved quote shows its estimate; an older quote without one displays exactly as before', () => {
    const base = { id: 'q1', opportunityId: 'o1', status: 'SUBMITTED' as const, amountCents: 6_000_000, estimatedHours: 400 }
    const props = { route: makeRouteApi(vi.fn() as never), toast: toast as never, workspaceId: 'ws1', target: { opportunityId: 'o1' }, onChanged: vi.fn() }
    const { unmount } = render(<QuoteCapture {...props} quote={{ ...base, estimate: SAVED }} />)
    expect(screen.getByText(/Quoted/)).toHaveTextContent('Quoted $60,000 · 400 h estimated')
    expect(screen.getByRole('region', { name: 'Saved estimate' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    unmount()
    render(<QuoteCapture {...props} quote={{ ...base, estimate: null }} />)
    expect(screen.getByText(/Quoted/)).toHaveTextContent('Quoted $60,000 · 400 h estimated')
    expect(screen.queryByRole('region', { name: 'Saved estimate' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Client accepted' })).toBeInTheDocument()
  })
})

describe('Save quote buttons', () => {
  const props = (api: ReturnType<typeof vi.fn>) => ({ route: makeRouteApi(api as never), toast: toast as never, workspaceId: 'ws1', target: { opportunityId: 'o1' }, quote: null, onChanged: vi.fn() })
  const ESTIMATE_REPLY = { estimate: { labourCostCents: null, labourIncludesOnCosts: false, materialsCents: null, subcontractCents: null, directCostCents: null, knownDirectCostCents: 0, overheadCents: null, totalCostCents: null, priceCents: null, grossMarginCents: null, grossMarginPct: null, marginAfterOverheadsCents: null, marginAfterOverheadsPct: null, targetMarginPct: null, priceForTargetCents: null, trackRecord: null, gaps: [] }, crewRates: { activeCrew: 0, ratedCrew: 0, medianBaseRate: null }, check: null }
  const quotePosts = (api: ReturnType<typeof vi.fn>) => api.mock.calls.filter(c => c[0] === '/api/delivery/quotes') as unknown as Array<[string, { body: string }]>

  test('the Save below the estimate submits exactly what the top Save does', async () => {
    const bodies: unknown[] = []
    for (const which of ['top', 'bottom'] as const) {
      const api = vi.fn((path: string) => Promise.resolve(path === '/api/delivery/estimate' ? ESTIMATE_REPLY : { quote: {} }))
      const { unmount } = render(<QuoteCapture {...props(api)} />)
      await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
      await userEvent.click(screen.getByRole('button', { name: 'Build estimate' }))
      await userEvent.type(screen.getByLabelText('Quote amount ($)'), '60000')
      await userEvent.type(screen.getByLabelText('Estimated labour hours'), '400')
      await userEvent.type(screen.getByLabelText('Materials ($)'), '15000')
      expect(screen.getAllByRole('button', { name: 'Save quote' })).toHaveLength(2)
      await userEvent.click(which === 'top' ? screen.getAllByRole('button', { name: 'Save quote' })[0] : screen.getByTestId('save-quote-bottom'))
      await waitFor(() => expect(quotePosts(api)).toHaveLength(1), { timeout: 3000 })
      bodies.push(JSON.parse(quotePosts(api)[0][1].body))
      unmount()
    }
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({ amountCents: 6_000_000, estimatedHours: 400, estimate: { materialsCents: 1_500_000 } })
  })

  test('a double tap posts once; validation applies to the lower button too', async () => {
    let release: (v: unknown) => void = () => {}
    const api = vi.fn((path: string) => (path === '/api/delivery/estimate' ? Promise.resolve(ESTIMATE_REPLY) : new Promise(r => { release = r })))
    render(<QuoteCapture {...props(api)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    await userEvent.click(screen.getByRole('button', { name: 'Build estimate' }))
    await userEvent.click(screen.getByTestId('save-quote-bottom'))
    expect(toast.error).toHaveBeenCalledWith('Enter the quoted amount in dollars')
    expect(quotePosts(api)).toHaveLength(0)

    await userEvent.type(screen.getByLabelText('Quote amount ($)'), '60000')
    const bottom = screen.getByTestId('save-quote-bottom')
    await userEvent.dblClick(bottom)
    await userEvent.click(screen.getAllByRole('button', { name: 'Save quote' })[0])
    expect(quotePosts(api)).toHaveLength(1)
    release({ quote: {} })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Quote recorded'))
  })
})
