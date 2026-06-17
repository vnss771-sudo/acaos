import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { OutboxHealth } from './OutboxHealth.js'

afterEach(() => vi.restoreAllMocks())

const clean = { failed: [], stuck: [], failedCount: 0, stuckCount: 0, stuckMinutes: 10, hasIssues: false }

describe('OutboxHealth', () => {
  test('surfaces failed sends with their error and stuck sends', async () => {
    const data = {
      failed: [{ id: 'o1', toEmail: 'a@x.com', subject: 's', status: 'FAILED', lastError: 'SMTP 550 rejected', sentAt: new Date().toISOString(), campaignId: 'c1' }],
      stuck: [{ id: 'o2', toEmail: 'b@x.com', subject: 's', status: 'SENDING', lastError: null, sentAt: new Date(0).toISOString(), campaignId: 'c1' }],
      failedCount: 1, stuckCount: 1, stuckMinutes: 10, hasIssues: true,
    }
    const api = vi.fn(() => Promise.resolve(data))
    render(<OutboxHealth api={api as never} workspaceId="ws1" />)

    expect(await screen.findByText('Delivery needs attention')).toBeInTheDocument()
    expect(screen.getByText('a@x.com')).toBeInTheDocument()
    expect(screen.getByText('SMTP 550 rejected')).toBeInTheDocument()
    expect(screen.getByText('b@x.com')).toBeInTheDocument()
    expect(screen.getByText('1 failed · 1 stuck')).toBeInTheDocument()
  })

  test('renders nothing when the outbox is clean', async () => {
    const api = vi.fn(() => Promise.resolve(clean))
    const { container } = render(<OutboxHealth api={api as never} workspaceId="ws1" />)
    await waitFor(() => expect(api).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
