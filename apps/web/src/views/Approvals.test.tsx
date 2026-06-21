import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApprovalsView } from './Approvals.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }

type Draft = {
  id: string
  subject: string
  emailBody: string
  status: 'PENDING'
  createdAt: string
  lead: { id: string; businessName: string; email: string }
}

function fixtures(): Draft[] {
  return [
    { id: 'd1', subject: 'Hi Meridian', emailBody: 'Body one', status: 'PENDING', createdAt: '2026-06-01T00:00:00Z', lead: { id: 'l1', businessName: 'Meridian Roofing', email: 'ops@meridian.test' } },
    { id: 'd2', subject: 'Hi Apex', emailBody: 'Body two', status: 'PENDING', createdAt: '2026-06-01T00:00:00Z', lead: { id: 'l2', businessName: 'Apex Plumbing', email: 'hi@apex.test' } },
  ]
}

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

function makeApi(drafts: Draft[]) {
  return vi.fn((path: string) => {
    if (path.includes('/approvals/pending')) return Promise.resolve({ drafts })
    return Promise.resolve({})
  })
}

beforeEach(() => vi.clearAllMocks())

describe('ApprovalsView', () => {
  test('shows the empty state when there are no pending drafts', async () => {
    const api = makeApi([])
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    expect(await screen.findByText(/No drafts awaiting review/i)).toBeInTheDocument()
  })

  test('renders each pending draft with a pending count', async () => {
    const api = makeApi(fixtures())
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    expect(await screen.findByText('Meridian Roofing')).toBeInTheDocument()
    expect(screen.getByText('Apex Plumbing')).toBeInTheDocument()
    expect(screen.getByText(/2 pending/i)).toBeInTheDocument()
  })

  test('approving a single draft calls the per-draft endpoint and removes it', async () => {
    const api = makeApi(fixtures())
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Meridian Roofing')

    // Each card has its own Approve button; the first one is Meridian's.
    const approveButtons = screen.getAllByRole('button', { name: /^Approve$/ })
    await userEvent.click(approveButtons[0])

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/leads/l1/drafts/d1/approve', { method: 'POST' }),
    )
    await waitFor(() => expect(screen.queryByText('Meridian Roofing')).not.toBeInTheDocument())
    // The other draft remains.
    expect(screen.getByText('Apex Plumbing')).toBeInTheDocument()
  })

  test('select-all then Approve selected calls the endpoint for every draft', async () => {
    const api = makeApi(fixtures())
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Meridian Roofing')

    await userEvent.click(screen.getByLabelText('Select all drafts'))
    await userEvent.click(screen.getByRole('button', { name: /Approve selected/i }))

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/leads/l1/drafts/d1/approve', { method: 'POST' }),
    )
    expect(api).toHaveBeenCalledWith('/api/leads/l2/drafts/d2/approve', { method: 'POST' })
    await waitFor(() => expect(screen.queryByText('Meridian Roofing')).not.toBeInTheDocument())
    expect(screen.queryByText('Apex Plumbing')).not.toBeInTheDocument()
  })

  test('surfaces compliance risk flags on a risky draft', async () => {
    const api = makeApi(fixtures())
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Meridian Roofing')
    // The fixture drafts are short and lack opt-out language, so each card shows risk checks.
    const groups = screen.getAllByLabelText('Draft risk checks')
    expect(groups.length).toBeGreaterThan(0)
    expect(screen.getAllByText(/No opt-out language/i).length).toBeGreaterThan(0)
  })

  test('hides selection and action controls when the user cannot manage', async () => {
    const api = makeApi(fixtures())
    render(<ApprovalsView api={api as never} workspace={workspace} toast={toast as never} canManage={false} />)
    await screen.findByText('Meridian Roofing')
    expect(screen.queryByLabelText('Select all drafts')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve selected/i })).not.toBeInTheDocument()
  })
})
