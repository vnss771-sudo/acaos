import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Billing } from './Billing.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

// jsdom doesn't implement navigation; make window.location.href assignable.
let origLocation: Location
beforeEach(() => {
  origLocation = window.location
  // @ts-expect-error override for test
  delete window.location
  // @ts-expect-error minimal stub
  window.location = { href: '' }
})
afterEach(() => {
  // @ts-expect-error restore
  window.location = origLocation
  vi.restoreAllMocks()
})

function apiFor(status: { plan: string; status: string; hasSubscription: boolean; entitlement?: unknown }, extra: Record<string, unknown> = {}) {
  return vi.fn((path: string, _init?: unknown) => {
    if (path.startsWith('/api/billing/status')) return Promise.resolve(status)
    if (path === '/api/billing/plans') return Promise.resolve({ plans: PLAN_CATALOG })
    if (path === '/api/billing/checkout') return Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/sess_1' })
    return Promise.resolve(extra)
  })
}

// Mirrors the backend getPlanCatalog() (Infinity -> null). The Billing cards must
// render their numbers from THIS, not hardcode them.
const PLAN_CATALOG = {
  free: { maxLeads: 500, aiCallsPerMonth: 15, discoveriesPerMonth: 25 },
  starter: { maxLeads: 10_000, aiCallsPerMonth: 300, discoveriesPerMonth: 500 },
  growth: { maxLeads: null, aiCallsPerMonth: null, discoveriesPerMonth: null },
}

describe('Billing', () => {
  test('shows the current plan and upgrade cards when there is no active subscription', async () => {
    const api = apiFor({ plan: 'free', status: 'none', hasSubscription: false })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByText('Upgrade your plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upgrade to Contractor →/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upgrade to Contractor Pro/i })).toBeInTheDocument()
    // Who each plan is for, as in POSITIONING.md — not the old agency copy.
    expect(screen.getByText('For most trade businesses')).toBeInTheDocument()
    expect(screen.getByText('For multi-crew businesses')).toBeInTheDocument()
    expect(screen.queryByText(/agencies/i)).toBeNull()
    expect(api).toHaveBeenCalledWith('/api/billing/status?workspaceId=ws1')
  })

  test('starting checkout posts to the checkout endpoint and redirects', async () => {
    const api = apiFor({ plan: 'free', status: 'none', hasSubscription: false })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(await screen.findByRole('button', { name: /Upgrade to Contractor →/i }))

    expect(api).toHaveBeenCalledWith('/api/billing/checkout', expect.objectContaining({ method: 'POST' }))
    const checkoutCall = api.mock.calls.find(c => c[0] === '/api/billing/checkout')!
    const body = JSON.parse((checkoutCall[1] as { body: string }).body)
    expect(body.workspaceId).toBe('ws1')
    expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/sess_1')
  })

  test('renders plan limits from the backend catalog (single source of truth)', async () => {
    const api = apiFor({ plan: 'free', status: 'none', hasSubscription: false })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    // Numbers come from GET /api/billing/plans, not hardcoded copy.
    expect(await screen.findByText('Up to 500 leads')).toBeInTheDocument()        // free card
    expect(screen.getByText('15 AI requests per month')).toBeInTheDocument()      // free card
    expect(screen.getByText('Up to 10,000 leads')).toBeInTheDocument()            // starter card
    expect(screen.getByText('Unlimited AI requests per month')).toBeInTheDocument() // growth card (null)
    expect(api).toHaveBeenCalledWith('/api/billing/plans')
  })

  test('an active subscription shows Manage Subscription and hides upgrade cards', async () => {
    const api = apiFor({ plan: 'growth', status: 'active', hasSubscription: true })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByRole('button', { name: /Manage Subscription/i })).toBeInTheDocument()
    expect(screen.queryByText('Upgrade your plan')).not.toBeInTheDocument()
  })

  test('a past_due subscription in grace shows the deadline and no second checkout', async () => {
    const api = apiFor({
      plan: 'growth', status: 'past_due', hasSubscription: true,
      entitlement: { status: 'grace', effectivePlan: 'growth', graceUntil: '2026-10-16T12:00:00.000Z' },
    })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByText(/Your last payment failed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Manage Subscription/i })).toBeInTheDocument()
    expect(screen.queryByText('Upgrade your plan')).not.toBeInTheDocument()
  })

  test('a lapsed paid plan says Free limits apply', async () => {
    const api = apiFor({
      plan: 'starter', status: 'past_due', hasSubscription: true,
      entitlement: { status: 'lapsed', effectivePlan: 'free', graceUntil: '2026-10-01T12:00:00.000Z' },
    })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByText(/Free plan limits apply/i)).toBeInTheDocument()
  })

  // Regression: both fetches below previously failed silently (a bare
  // `.catch(() => {})`) — a transient error looked identical to a loading page
  // with no indication anything went wrong.
  test('surfaces a toast when the plan catalog request fails', async () => {
    const errorToast = { ...toast, error: vi.fn() }
    const api = vi.fn((path: string) => {
      if (path === '/api/billing/plans') return Promise.reject(new Error('boom'))
      if (path.startsWith('/api/billing/status')) return Promise.resolve({ plan: 'free', status: 'none', hasSubscription: false })
      return Promise.resolve({})
    })
    render(<Billing api={api as never} workspace={workspace} toast={errorToast as never} />)
    await waitFor(() => expect(errorToast.error).toHaveBeenCalledWith('Failed to load plan details'))
  })

  test('surfaces a toast when the billing status request fails', async () => {
    const errorToast = { ...toast, error: vi.fn() }
    const api = vi.fn((path: string) => {
      if (path.startsWith('/api/billing/status')) return Promise.reject(new Error('boom'))
      if (path === '/api/billing/plans') return Promise.resolve({ plans: PLAN_CATALOG })
      return Promise.resolve({})
    })
    render(<Billing api={api as never} workspace={workspace} toast={errorToast as never} />)
    await waitFor(() => expect(errorToast.error).toHaveBeenCalledWith('Failed to load billing status'))
  })
})
