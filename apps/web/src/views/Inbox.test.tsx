import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

  test('shows a persistent error banner (not just a toast) when the load fails, and Retry reloads', async () => {
    const api = vi.fn().mockRejectedValue(new Error('Network error'))
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to load replies/i)
    expect(toast.error).toHaveBeenCalledWith('Network error')

    api.mockResolvedValue(payload)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('Reply sends only what the user typed — never the suggested next step', async () => {
    const api = vi.fn().mockImplementation((path: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'POST' ? { success: true, sentAt: '2026-06-03T00:00:00Z', message: 'ok' } : payload),
    )
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')

    // There is no one-click "send the suggestion" path any more.
    expect(screen.queryByRole('button', { name: /Send suggested/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))
    const send = screen.getByRole('button', { name: 'Send reply' })
    // The composer starts empty (not pre-filled with the internal note), so Send is off.
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(send).toBeDisabled()

    await userEvent.type(screen.getByRole('textbox'), 'Does Tuesday at 10 work?')
    await userEvent.click(send)

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const post = api.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')!
    expect(post[0]).toBe('/api/inbox/reply/r1/send')
    const body = JSON.parse((post[1] as { body: string }).body)
    expect(body.body).toBe('Does Tuesday at 10 work?')
    expect(body.workspaceId).toBe('ws1')
    expect(typeof body.idempotencyKey).toBe('string')
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8)
    expect(JSON.stringify(body)).not.toContain('Propose three slots')
  })

  test('Draft reply with AI fills the composer for editing, and only the edited text is sent', async () => {
    const api = vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/inbox/reply/r1/draft') return Promise.resolve({ body: 'Thanks! Would [Tuesday 10am] work?' })
      if (init?.method === 'POST') return Promise.resolve({ success: true, sentAt: '2026-06-03T00:00:00Z', message: 'ok' })
      return Promise.resolve(payload)
    })
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')

    await userEvent.click(screen.getByRole('button', { name: 'Draft reply with AI' }))
    const box = screen.getByRole('textbox')
    await waitFor(() => expect(box).toHaveValue('Thanks! Would [Tuesday 10am] work?'))
    // Drafting never sends: only the draft call has gone out.
    expect(api.mock.calls.filter(([p]) => String(p).endsWith('/send'))).toHaveLength(0)
    expect(screen.getByText(/Fill in anything in \[brackets\]/)).toBeInTheDocument()
    // With text in the box, drafting again is off until it's cleared.
    expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeDisabled()

    await userEvent.clear(box)
    await userEvent.type(box, 'Thanks! Would Tuesday at 10 work?')
    await userEvent.click(screen.getByRole('button', { name: 'Send reply' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const send = api.mock.calls.find(([p]) => p === '/api/inbox/reply/r1/send')!
    expect(JSON.parse((send[1] as { body: string }).body).body).toBe('Thanks! Would Tuesday at 10 work?')
  })

  test('a failed draft shows an error and leaves the composer empty', async () => {
    const api = vi.fn().mockImplementation((path: string) =>
      path.endsWith('/draft') ? Promise.reject(new Error('AI limit reached')) : Promise.resolve(payload),
    )
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')

    await userEvent.click(screen.getByRole('button', { name: 'Draft reply with AI' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('AI limit reached'))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeEnabled()
  })

  test('a draft that returns after the composer was cancelled is dropped', async () => {
    let resolveDraft!: (v: unknown) => void
    const api = vi.fn().mockImplementation((path: string) =>
      path.endsWith('/draft') ? new Promise(r => { resolveDraft = r }) : Promise.resolve(payload),
    )
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')

    await userEvent.click(screen.getByRole('button', { name: 'Draft reply with AI' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    resolveDraft({ body: 'Late draft' })
    await userEvent.click(await screen.findByRole('button', { name: 'Reply' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  test('a late draft never overwrites text typed after reopening the composer', async () => {
    let resolveDraft!: (v: unknown) => void
    const api = vi.fn().mockImplementation((path: string) =>
      path.endsWith('/draft') ? new Promise(r => { resolveDraft = r }) : Promise.resolve(payload),
    )
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')

    await userEvent.click(screen.getByRole('button', { name: 'Draft reply with AI' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await userEvent.type(screen.getByRole('textbox'), 'My own words')
    resolveDraft({ body: 'Late draft' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Draft with AI' })).not.toHaveTextContent('Drafting'))
    expect(screen.getByRole('textbox')).toHaveValue('My own words')
  })

  test('an outcome-unknown reply pauses replying and can be resolved', async () => {
    const pending = {
      ...payload,
      replies: [{ ...payload.replies[0], pendingSend: { id: 's1', attemptedAt: '2026-06-03T00:00:00Z', outcomeUnknown: true, bodyPreview: 'Does Tuesday work?' } }],
    }
    const api = vi.fn().mockImplementation((path: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'POST' ? { success: true, status: 'SENT' } : pending),
    )
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/couldn't confirm whether your reply/i)).toBeInTheDocument()
    expect(screen.getByText(/Does Tuesday work\?/)).toBeInTheDocument()
    // No way to write a second reply until it's resolved.
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'It was sent' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marked as sent'))
    const post = api.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')!
    expect(post[0]).toBe('/api/inbox/reply/r1/sends/s1/resolve')
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({ workspaceId: 'ws1', outcome: 'sent' })
  })

  test('👎 asks which label it should have been and sends the correction', async () => {
    const accuracyReport = {
      days: 90, reviewed: 12, correct: 9, incorrect: 3, unsure: 0, accuracy: 0.75, withheldReason: null,
      labels: [], mistakes: [{ from: 'NOT_NOW', to: 'INTERESTED', count: 2 }],
      overturnedNegatives: { count: 0, aboveFloor: 0, floor: 60 }, recommendation: null,
    }
    const api = vi.fn().mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return Promise.resolve({ success: true, message: 'ok', stageApplied: null, outcomeCorrected: true })
      if (path.startsWith('/api/inbox/classification-accuracy')) return Promise.resolve(accuracyReport)
      return Promise.resolve(payload)
    })
    render(<InboxView api={api as never} workspace={workspace} toast={toast as never} />)
    await screen.findByText('Meridian Roofing')
    expect(await screen.findByText(/75% right across 12 replies/)).toBeInTheDocument()
    expect(screen.getByText(/not now → interested \(2\)/)).toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Mark as incorrect'))
    const picker = screen.getByRole('group', { name: /What should this reply have been/ })
    await userEvent.click(within(picker).getByRole('button', { name: 'Not now' }))

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/api/inbox/reply/r1/feedback',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ workspaceId: 'ws1', feedback: 'incorrect', correctedIntent: 'NOT_NOW' }) }),
    ))
    expect(toast.success).toHaveBeenCalledWith('Corrected to Not now')
  })
})
