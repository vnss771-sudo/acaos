import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

function apiFor(status: { plan: string; status: string; hasSubscription: boolean }, extra: Record<string, unknown> = {}) {
  return vi.fn((path: string, _init?: unknown) => {
    if (path.startsWith('/api/billing/status')) return Promise.resolve(status)
    if (path === '/api/billing/checkout') return Promise.resolve({ url: 'https://checkout.stripe/sess_1' })
    return Promise.resolve(extra)
  })
}

describe('Billing', () => {
  test('shows the current plan and upgrade cards when there is no active subscription', async () => {
    const api = apiFor({ plan: 'free', status: 'none', hasSubscription: false })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByText('Upgrade your plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upgrade to Starter/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upgrade to Growth/i })).toBeInTheDocument()
    expect(api).toHaveBeenCalledWith('/api/billing/status?workspaceId=ws1')
  })

  test('starting checkout posts to the checkout endpoint and redirects', async () => {
    const api = apiFor({ plan: 'free', status: 'none', hasSubscription: false })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(await screen.findByRole('button', { name: /Upgrade to Starter/i }))

    expect(api).toHaveBeenCalledWith('/api/billing/checkout', expect.objectContaining({ method: 'POST' }))
    const checkoutCall = api.mock.calls.find(c => c[0] === '/api/billing/checkout')!
    const body = JSON.parse((checkoutCall[1] as { body: string }).body)
    expect(body.workspaceId).toBe('ws1')
    expect(window.location.href).toBe('https://checkout.stripe/sess_1')
  })

  test('an active subscription shows Manage Subscription and hides upgrade cards', async () => {
    const api = apiFor({ plan: 'growth', status: 'active', hasSubscription: true })
    render(<Billing api={api as never} workspace={workspace} toast={toast as never} />)

    expect(await screen.findByRole('button', { name: /Manage Subscription/i })).toBeInTheDocument()
    expect(screen.queryByText('Upgrade your plan')).not.toBeInTheDocument()
  })
})
