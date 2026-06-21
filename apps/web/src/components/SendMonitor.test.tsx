import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SendMonitor } from './SendMonitor.js'

const summary = {
  total: 103, delivered: 103, sent: 78, replied: 22, bounced: 3, failed: 1,
  sending: 0, last24hSent: 12, replyRate: 21.4,
}

describe('SendMonitor', () => {
  test('renders the delivery summary once loaded', async () => {
    const api = vi.fn().mockResolvedValue(summary)
    render(<SendMonitor api={api as never} workspaceId="ws1" setView={vi.fn()} />)
    expect(await screen.findByText('Outreach Activity')).toBeInTheDocument()
    expect(screen.getByText('21.4%')).toBeInTheDocument()      // reply rate
    expect(screen.getByText('12')).toBeInTheDocument()         // last 24h
    expect(api).toHaveBeenCalledWith('/api/sends/summary?workspaceId=ws1')
  })

  test('surfaces a delivery-issues prompt that routes to campaigns', async () => {
    const api = vi.fn().mockResolvedValue(summary)
    const setView = vi.fn()
    render(<SendMonitor api={api as never} workspaceId="ws1" setView={setView} />)
    await screen.findByText('Outreach Activity')
    // bounced(3) + failed(1) = 4 issues
    expect(screen.getByText(/4 delivery issues/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Review delivery/i }))
    expect(setView).toHaveBeenCalledWith('campaigns')
  })

  test('hides itself when no outreach has been sent', async () => {
    const api = vi.fn().mockResolvedValue({ ...summary, total: 0 })
    const { container } = render(<SendMonitor api={api as never} workspaceId="ws1" setView={vi.fn()} />)
    await waitFor(() => expect(api).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
