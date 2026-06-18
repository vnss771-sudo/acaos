import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApprovalsView } from './Approvals.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'd1', subject: 'Quick question', emailBody: 'Hi there', status: 'DRAFTED', createdAt: '2026-06-01T00:00:00Z',
    lead: { id: 'l1', businessName: 'Acme Co', email: 'ops@acme.com' },
    ...over,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('ApprovalsView', () => {
  test('shows the empty state when nothing is pending', async () => {
    const api = vi.fn().mockResolvedValue({ drafts: [] })
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText(/No drafts awaiting review/i)).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/leads/approvals/pending?workspaceId=ws1')
  })

  test('renders a pending draft with the lead, subject and body, and a count', async () => {
    const api = vi.fn().mockResolvedValue({ drafts: [draft()] })
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} />)
    expect(await screen.findByText('Acme Co')).toBeInTheDocument()
    expect(screen.getByText('ops@acme.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Quick question')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Hi there')).toBeInTheDocument()
    expect(screen.getByText(/1 pending/)).toBeInTheDocument()
  })

  test('approving an unedited draft POSTs approve and removes it from the list', async () => {
    const api = vi.fn((path: string, init?: { method?: string }) => {
      if (path.endsWith('/approve')) return Promise.resolve({})
      return Promise.resolve({ drafts: [draft()] })
    })
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(api).toHaveBeenCalledWith('/api/leads/l1/drafts/d1/approve', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(screen.queryByText('Acme Co')).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith('Approved — ready to send')
  })

  test('rejecting a draft POSTs reject and removes it', async () => {
    const api = vi.fn((path: string) => {
      if (path.endsWith('/reject')) return Promise.resolve({})
      return Promise.resolve({ drafts: [draft()] })
    })
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(api).toHaveBeenCalledWith('/api/leads/l1/drafts/d1/reject', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(screen.queryByText('Acme Co')).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith('Rejected')
  })

  test('editing the subject reveals Save edits and switches the approve label to Save & Approve', async () => {
    const api = vi.fn((path: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return Promise.resolve({ draft: { ...draft(), subject: 'Edited subject' } })
      if (path.endsWith('/approve')) return Promise.resolve({})
      return Promise.resolve({ drafts: [draft()] })
    })
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} />)

    const subject = await screen.findByDisplayValue('Quick question')
    await userEvent.type(subject, '!')
    expect(screen.getByRole('button', { name: 'Save edits' })).toBeInTheDocument()

    // Save & Approve must PATCH the edit first, then POST approve.
    await userEvent.click(screen.getByRole('button', { name: 'Save & Approve' }))
    await waitFor(() => {
      const paths = api.mock.calls.map(c => `${c[0]}:${(c[1] as any)?.method ?? 'GET'}`)
      expect(paths).toContain('/api/leads/l1/drafts/d1:PATCH')
      expect(paths).toContain('/api/leads/l1/drafts/d1/approve:POST')
    })
  })

  test('surfaces a toast when loading approvals fails', async () => {
    const api = vi.fn().mockRejectedValue(new Error('nope'))
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} />)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })
})
