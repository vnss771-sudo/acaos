import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GettingStarted } from './GettingStarted.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

const notReady = {
  ready: false,
  checks: [
    { name: 'smtpConfigured', label: 'Email sending configured', ok: false, hint: 'Add SMTP host.' },
    { name: 'senderBusinessName', label: 'Business name set', ok: true, hint: 'CAN-SPAM.' },
    { name: 'senderPostalAddress', label: 'Postal / contact address set', ok: false, hint: 'Required.' },
  ],
}

describe('GettingStarted', () => {
  test('renders the readiness checklist with progress and hints for missing items', async () => {
    const api = vi.fn((path: string) => {
      if (path.includes('/send-readiness')) return Promise.resolve(notReady)
      return Promise.resolve({})
    })
    render(<GettingStarted api={api as never} workspaceId="ws1" toast={toast as never} />)

    expect(await screen.findByText('Get set up to send')).toBeInTheDocument()
    expect(screen.getByText('1/3 ready')).toBeInTheDocument()
    expect(screen.getByText('Add SMTP host.')).toBeInTheDocument()        // hint for a missing item
    expect(screen.queryByText('CAN-SPAM.')).not.toBeInTheDocument()       // hint hidden for a done item
  })

  test('renders nothing once the workspace is send-ready', async () => {
    const api = vi.fn(() => Promise.resolve({ ready: true, checks: [] }))
    const { container } = render(<GettingStarted api={api as never} workspaceId="ws1" toast={toast as never} />)
    await waitFor(() => expect(api).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  test('Apply FieldOps preset posts to the pack endpoint', async () => {
    const api = vi.fn((path: string) => {
      if (path.includes('/send-readiness')) return Promise.resolve(notReady)
      return Promise.resolve({})
    })
    render(<GettingStarted api={api as never} workspaceId="ws1" toast={toast as never} />)

    await userEvent.click(await screen.findByText('Apply FieldOps preset'))
    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/packs/fieldops/apply',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspaceId: 'ws1' }) }),
    ))
    expect(toast.success).toHaveBeenCalled()
  })
})
