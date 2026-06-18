import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OutreachIntents } from './OutreachIntents.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

describe('OutreachIntents', () => {
  test('renders opportunities and fires draft generation on the right endpoint', async () => {
    const intents = [{
      id: 'i1', status: 'PROPOSED', messageAngle: 'scheduling', draftSubject: null, draftBody: null,
      prospect: { id: 'p1', companyName: 'Acme Plumbing', industry: 'Plumbing', location: 'Bne', opportunityScore: 82 },
      recommendation: { reasoning: 'Hiring spike', actionText: null, urgency: 'HIGH' },
    }]
    const api = vi.fn((path: string) => (path.includes('/intents?') ? Promise.resolve({ intents }) : Promise.resolve({})))
    render(<OutreachIntents api={api as never} workspaceId="ws1" toast={toast as never} />)

    expect(await screen.findByText(/This week/)).toBeInTheDocument()
    expect(screen.getByText('Acme Plumbing')).toBeInTheDocument()
    expect(screen.getByText('Hiring spike')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Generate draft' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prospects/p1/intents/i1/draft', expect.objectContaining({ method: 'POST' })))
  })

  test('renders nothing when there are no actionable intents', async () => {
    const api = vi.fn(() => Promise.resolve({ intents: [] }))
    const { container } = render(<OutreachIntents api={api as never} workspaceId="ws1" toast={toast as never} />)
    await waitFor(() => expect(api).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
