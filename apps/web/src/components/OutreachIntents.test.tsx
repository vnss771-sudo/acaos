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

    expect(await screen.findByText(/Ready to contact/)).toBeInTheDocument()
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

  // After "Prepare to send" the send gate opens in place: it shows the exact email,
  // recipient, sender and readiness, and Send dispatches only this one lead.
  function sendFlowApi(opts: { ready: boolean; suppressed?: boolean }) {
    const base = {
      id: 'i1', status: 'APPROVED', origin: 'ONBOARDING', messageAngle: null,
      draftSubject: 'Quick idea for Acme', draftBody: 'Hi Mark, saw you are hiring.',
      prospect: { id: 'p1', companyName: 'Acme Plumbing', industry: null, location: null, opportunityScore: 41, contactEmail: 'mark@acme.test', contactName: 'Mark' },
      recommendation: null,
    }
    let materialized = false
    return vi.fn((path: string, init?: { method?: string }) => {
      if (path.includes('/intents?')) {
        return Promise.resolve({ intents: [materialized
          ? { ...base, leadId: 'l1', campaignId: 'c1', campaignName: 'ACAOS Radar', recipientSuppressed: !!opts.suppressed }
          : { ...base, leadId: null, campaignId: null }] })
      }
      if (path.endsWith('/materialize') && init?.method === 'POST') { materialized = true; return Promise.resolve({ leadId: 'l1', campaignId: 'c1' }) }
      if (path.startsWith('/api/campaigns/send-readiness')) {
        return Promise.resolve({ ready: opts.ready, checks: [{ name: 'smtp', label: 'Email sending configured', ok: opts.ready, hint: 'Add SMTP in Settings' }] })
      }
      if (path.endsWith('/email-config')) return Promise.resolve({ config: { smtpFrom: 'sales@northwind.test' } })
      return Promise.resolve({ jobId: 'j1', eligible: 1, message: 'ok' })
    })
  }

  test('onboarding intents are labelled as not evidence-based', async () => {
    const api = sendFlowApi({ ready: true })
    render(<OutreachIntents api={api as never} workspaceId="ws1" toast={toast as never} />)
    expect(await screen.findByText(/not an evidence-based recommendation/)).toBeInTheDocument()
  })

  test('prepare opens the send gate, and Send dispatches only that lead', async () => {
    const api = sendFlowApi({ ready: true })
    render(<OutreachIntents api={api as never} workspaceId="ws1" toast={toast as never} senderBusinessName="Northwind" />)
    await userEvent.click(await screen.findByRole('button', { name: /Prepare to send/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Send this email now?' })
    expect(dialog).toHaveTextContent('mark@acme.test')
    expect(dialog).toHaveTextContent('Quick idea for Acme')
    expect(dialog).toHaveTextContent('ACAOS Radar')
    await waitFor(() => expect(dialog).toHaveTextContent('Northwind <sales@northwind.test>'))

    const send = screen.getByRole('button', { name: 'Send email' })
    await waitFor(() => expect(send).toBeEnabled())
    await userEvent.click(send)
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/campaigns/c1/send', { method: 'POST', body: JSON.stringify({ approved: true, leadIds: ['l1'] }) }))
    expect(await screen.findByText('Sending…')).toBeInTheDocument()
  })

  test('send is blocked while the workspace is not ready or the recipient is suppressed', async () => {
    const api = sendFlowApi({ ready: false, suppressed: true })
    render(<OutreachIntents api={api as never} workspaceId="ws1" toast={toast as never} />)
    await userEvent.click(await screen.findByRole('button', { name: /Prepare to send/ }))
    await screen.findByText(/Add SMTP in Settings/)
    expect(screen.getByRole('alert')).toHaveTextContent(/suppression list/)
    expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled()
    expect(api).not.toHaveBeenCalledWith('/api/campaigns/c1/send', expect.anything())
  })
})
