import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuoteCapture, quoteLifecycleCue, adjustedHours, type EstimateCheck } from './QuoteCapture'
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
