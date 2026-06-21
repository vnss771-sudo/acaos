import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InboxView } from './Inbox.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const payload = {
  replies: [
    { id: 'r1', toEmail: 'a@x.test', subject: 'Intro to Meridian', sentAt: '2026-06-01T00:00:00Z', repliedAt: '2026-06-02T00:00:00Z', replyIntent: 'INTERESTED', replySummary: 'Wants a call', replyKeyQuote: 'send times', replySuggestedAction: 'Propose three slots', replyUrgency: 'this_week', replyConfidence: 90, replyIsAutoReply: false, lead: { id: 'l1', businessName: 'Meridian Roofing', stage: 'REPLIED' } },
  ],
  counts: { INTERESTED: 1, NOT_INTERESTED: 2 },
  total: 3,
}

beforeEach(() => vi.clearAllMocks())

describe('InboxView', () => {
  test('shows an empty state when no workspace is selected', () => {
    const api = vi.fn()
    render(<InboxView api={api as never} workspace={null} toast={toast as never} />)
    expect(screen.getByText(/No workspace selected/i)).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  test('loads replies and renders the classification + suggested action', async () => {
    const api = vi.fn().mockResolvedValue(payload)
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument()
    expect(screen.getByText('Interested')).toBeInTheDocument()
    expect(screen.getByText(/Propose three slots/)).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/inbox?workspaceId=ws1')
  })

  test('clicking a filter chip refetches with the classification', async () => {
    const api = vi.fn().mockResolvedValue(payload)
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')

    // The "Not interested (2)" chip exists because counts has NOT_INTERESTED.
    await userEvent.click(screen.getByRole('button', { name: /Not interested/i }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/inbox?workspaceId=ws1&classification=NOT_INTERESTED'),
    )
  })

  test('shows the empty state when there are no replies', async () => {
    const api = vi.fn().mockResolvedValue({ replies: [], counts: {}, total: 0 })
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/No replies yet/i)).toBeInTheDocument()
  })
})
