import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EstimateBuilder, toInputs, type EstimateResult } from './EstimateBuilder'
import { QuoteCapture } from './QuoteCapture'
import { makeRouteApi } from '../../lib/routeApi.js'

const ESTIMATE: EstimateResult = {
  labourCostCents: 2_400_000, labourIncludesOnCosts: true, materialsCents: 1_500_000, subcontractCents: 500_000,
  directCostCents: 4_400_000, knownDirectCostCents: 4_400_000, overheadCents: 440_000, totalCostCents: 4_840_000,
  priceCents: 6_000_000, grossMarginCents: 1_600_000, grossMarginPct: 26.7, marginAfterOverheadsCents: 1_160_000, marginAfterOverheadsPct: 19.3,
  targetMarginPct: 25, priceForTargetCents: 5_866_667,
  trackRecord: { hoursFactor: 1.11, adjustedHours: 444, grossMarginCents: 1_336_000, grossMarginPct: 22.3, marginAfterOverheadsCents: 869_600 },
  gaps: [],
}
const CREW = { activeCrew: 4, ratedCrew: 3, medianBaseRate: 52.5 }
// The builder debounces its preview by 300 ms; allow for a slow runner.
const SLOW = { timeout: 3000 }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

describe('toInputs', () => {
  test('blank is not entered (null), never zero; dollars become cents', () => {
    expect(toInputs('', { rate: '', onCost: '', materials: '', subcontract: '', overhead: '', target: '' }))
      .toEqual({ inputs: { labourHours: null, labourRate: null, onCostPct: null, materialsCents: null, subcontractCents: null, overheadPct: null, targetMarginPct: null } })
    expect(toInputs('400', { rate: '50', onCost: '20%', materials: '$15,000', subcontract: '0', overhead: '10', target: '25' }))
      .toEqual({ inputs: { labourHours: 400, labourRate: 50, onCostPct: 20, materialsCents: 1_500_000, subcontractCents: 0, overheadPct: 10, targetMarginPct: 25 } })
  })
  test('names the first field that is not a number; a target margin over 95 is refused', () => {
    expect(toInputs('abc', { rate: '', onCost: '', materials: '', subcontract: '', overhead: '', target: '' })).toEqual({ invalid: 'Estimated labour hours' })
    expect(toInputs('', { rate: '', onCost: '', materials: '1.2.3', subcontract: '', overhead: '', target: '' })).toEqual({ invalid: 'Materials' })
    expect(toInputs('', { rate: '', onCost: '', materials: '', subcontract: '', overhead: '', target: '100' })).toEqual({ invalid: 'Target margin' })
  })
})

describe('EstimateBuilder', () => {
  test('previews from the server with blanks sent as null, and shows margin, track record and price for target', async () => {
    const api = vi.fn((..._args: unknown[]) => Promise.resolve({ estimate: ESTIMATE, crewRates: CREW, check: null }))
    const onUsePrice = vi.fn(); const onInputs = vi.fn()
    render(<EstimateBuilder route={makeRouteApi(api as never)} workspaceId="ws1" target={{ opportunityId: 'o1' }} priceCents={6_000_000} hours="400" onUsePrice={onUsePrice} onInputs={onInputs} />)
    await userEvent.type(screen.getByLabelText('Materials ($)'), '15000')
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/delivery/estimate', expect.objectContaining({ method: 'POST' })), SLOW)
    const body = JSON.parse((api.mock.calls[api.mock.calls.length - 1]![1] as { body: string }).body)
    expect(body).toEqual({ workspaceId: 'ws1', opportunityId: 'o1', priceCents: 6_000_000, inputs: { labourHours: 400, labourRate: null, onCostPct: null, materialsCents: 1_500_000, subcontractCents: null, overheadPct: null, targetMarginPct: null } })
    expect(onInputs).toHaveBeenLastCalledWith(body.inputs)

    const region = await screen.findByRole('region', { name: 'Estimate' }, SLOW)
    expect(region).toHaveTextContent('gross margin $16,000 (26.7%)')
    expect(region).toHaveTextContent('after overheads $11,600 (19.3%)')
    expect(region).toHaveTextContent('If labour runs like your recent comparable jobs (444 h): gross margin $13,360 (22.3%)')
    await userEvent.click(screen.getByRole('button', { name: 'Use this price' }))
    expect(onUsePrice).toHaveBeenCalledWith(5_866_667)
    await userEvent.click(screen.getByRole('button', { name: 'Use it' }))
    expect(screen.getByLabelText('Labour rate ($/h)')).toHaveValue('52.5')
  })

  test('unknown costs are shown as unknown with what has been entered so far, plus the gaps', async () => {
    const partial = { ...ESTIMATE, subcontractCents: null, directCostCents: null, knownDirectCostCents: 3_900_000, grossMarginCents: null, grossMarginPct: null, marginAfterOverheadsCents: null, priceForTargetCents: null, trackRecord: null, gaps: ['Subcontractors not entered, so direct cost is unknown'] }
    const api = vi.fn(() => Promise.resolve({ estimate: partial, crewRates: { activeCrew: 0, ratedCrew: 0, medianBaseRate: null }, check: null }))
    render(<EstimateBuilder route={makeRouteApi(api as never)} workspaceId="ws1" target={{ opportunityId: 'o1' }} priceCents={null} hours="400" onUsePrice={vi.fn()} onInputs={vi.fn()} />)
    const region = await screen.findByRole('region', { name: 'Estimate' }, SLOW)
    expect(region).toHaveTextContent('Direct cost unknown ($39,000 entered so far)')
    expect(region).toHaveTextContent('Subcontractors not entered')
    expect(region).not.toHaveTextContent('gross margin')
    expect(screen.queryByRole('button', { name: 'Use this price' })).toBeNull()
    expect(screen.getByText(/No active crew have a base rate recorded/)).toBeInTheDocument()
  })

  test('an invalid field is named and nothing is previewed or offered for saving', async () => {
    const api = vi.fn(() => Promise.resolve({ estimate: ESTIMATE, crewRates: CREW, check: null }))
    const onInputs = vi.fn()
    render(<EstimateBuilder route={makeRouteApi(api as never)} workspaceId="ws1" target={{ opportunityId: 'o1' }} priceCents={null} hours="" onUsePrice={vi.fn()} onInputs={onInputs} />)
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1), SLOW)
    await userEvent.type(screen.getByLabelText('Target gross margin (%)'), '120')
    expect(screen.getByRole('alert')).toHaveTextContent('Target margin must be a number up to 95')
    expect(onInputs).toHaveBeenLastCalledWith(null)
    await new Promise(r => setTimeout(r, 400))
    expect(api).toHaveBeenCalledTimes(1)
  })
})

describe('QuoteCapture with the estimate builder', () => {
  test('advisory: "Use this price" only fills the field; saving sends the amount and hours as entered plus the estimate inputs', async () => {
    const api = vi.fn((path: string) => Promise.resolve(path === '/api/delivery/estimate' ? { estimate: ESTIMATE, crewRates: CREW, check: null } : { quote: {} }))
    render(<QuoteCapture route={makeRouteApi(api as never)} toast={toast as never} workspaceId="ws1" target={{ opportunityId: 'o1' }} quote={null} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    await userEvent.click(screen.getByRole('button', { name: 'Build estimate' }))
    await userEvent.type(screen.getByLabelText('Estimated labour hours'), '400')
    await userEvent.type(screen.getByLabelText('Materials ($)'), '15000')
    await userEvent.click(await screen.findByRole('button', { name: 'Use this price' }, SLOW))
    expect(screen.getByLabelText('Quote amount ($)')).toHaveValue('58666.67')
    expect(api.mock.calls.some(c => c[0] === '/api/delivery/quotes')).toBe(false)

    await userEvent.clear(screen.getByLabelText('Quote amount ($)'))
    await userEvent.type(screen.getByLabelText('Quote amount ($)'), '60000')
    await userEvent.click(screen.getAllByRole('button', { name: 'Save quote' })[0])
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/delivery/quotes', expect.objectContaining({ method: 'POST' })))
    const post = api.mock.calls.find(c => c[0] === '/api/delivery/quotes') as unknown as [string, { body: string }]
    expect(JSON.parse(post[1].body)).toEqual({
      workspaceId: 'ws1', opportunityId: 'o1', amountCents: 6_000_000, estimatedHours: 400, submit: true,
      estimate: { labourHours: 400, labourRate: null, onCostPct: null, materialsCents: 1_500_000, subcontractCents: null, overheadPct: null, targetMarginPct: null },
    })
  })

  test('without building an estimate the quote is saved exactly as before', async () => {
    const api = vi.fn(() => Promise.resolve({ quote: {} }))
    render(<QuoteCapture route={makeRouteApi(api as never)} toast={toast as never} workspaceId="ws1" target={{ opportunityId: 'o1' }} quote={null} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Record quote' }))
    await userEvent.type(screen.getByLabelText('Quote amount ($)'), '60000')
    await userEvent.click(screen.getByRole('button', { name: 'Save quote' }))
    await waitFor(() => expect(api).toHaveBeenCalled())
    expect(JSON.parse((api.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ workspaceId: 'ws1', opportunityId: 'o1', amountCents: 6_000_000, submit: true })
  })
})
