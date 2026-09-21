import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from './Settings.js'
import type { User, Workspace } from '../types.js'

const user: User = { id: 'u1', email: 'sarah@northwind.test', name: 'Sarah' }
const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'growth', _count: { leads: 42, campaigns: 3 } }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

function makeApi(overrides?: (path: string, init?: { method?: string }) => unknown) {
  return vi.fn((path: string, init?: { method?: string }) => {
    if (overrides) {
      const result = overrides(path, init)
      if (result !== undefined) return result
    }
    if (path.includes('/members')) return Promise.resolve({ members: [] })
    if (path.includes('/invites')) return Promise.resolve({ invites: [] })
    if (path.includes('/icp')) return Promise.resolve({ icp: null })
    if (path.includes('/email-config')) return Promise.resolve({ config: null })
    if (path.includes('/stats/reputation')) return Promise.resolve({
      healthy: true, totalSends: 0, bounces: 0, complaints: 0, bounceRate: 0, complaintRate: 0,
      reason: null, thresholds: { windowDays: 7, minSends: 50, maxBounceRate: 0.05, maxComplaintRate: 0.003 },
      guardMode: 'observe',
      warmup: { active: false, startedAt: null, day: null, totalDays: 8, cap: null, complete: false },
    })
    if (path.includes('/unsubscribe')) return Promise.resolve({ suppressions: [] })
    if (path.includes('/compliance')) return Promise.resolve({
      posture: {
        lawfulBasis: null, liaAcknowledgedAt: null, termsAcceptedAt: null, termsVersion: null,
        subprocessorsAckAt: null, subprocessorsAckVersion: null,
        dpaAcknowledgedAt: null, dpaAckVersion: null, targetsCanada: false,
      },
      consentCount: 0,
      currentTermsVersion: 'v1',
      subprocessors: { version: 'v1', subprocessors: [] },
      dpa: { version: 'v1', clauses: [] },
    })
    return Promise.resolve({})
  })
}

function renderSettings(api: ReturnType<typeof vi.fn>, over: Partial<React.ComponentProps<typeof Settings>> = {}) {
  const onUserUpdate = vi.fn()
  const onWorkspaceUpdate = vi.fn()
  render(
    <Settings api={api as never} user={user} workspace={workspace} toast={toast as never}
      onUserUpdate={onUserUpdate} onWorkspaceUpdate={onWorkspaceUpdate} {...over} />
  )
  return { onUserUpdate, onWorkspaceUpdate }
}

afterEach(() => vi.restoreAllMocks())

describe('Settings', () => {
  test('shows the (disabled) email and workspace info', async () => {
    renderSettings(makeApi())
    expect(screen.getByDisplayValue('sarah@northwind.test')).toBeDisabled()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Growth')).toBeInTheDocument()
    expect(await screen.findByText('No members yet.')).toBeInTheDocument()
  })

  test('saving the profile PATCHes and calls onUserUpdate', async () => {
    const api = makeApi((path, init) => {
      if (path === '/api/auth/profile' && init?.method === 'PATCH')
        return Promise.resolve({ user: { ...user, name: 'Sarah C' } })
    })
    const { onUserUpdate } = renderSettings(api)

    await userEvent.clear(screen.getByPlaceholderText('Your name'))
    await userEvent.type(screen.getByPlaceholderText('Your name'), 'Sarah C')
    await userEvent.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(api).toHaveBeenCalledWith('/api/auth/profile', expect.objectContaining({ method: 'PATCH' }))
    expect(onUserUpdate).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Profile updated')
  })

  test('password change is rejected client-side when the confirmation does not match', async () => {
    const api = makeApi()
    const { container } = render(
      <Settings api={api as never} user={user} workspace={workspace} toast={toast as never}
        onUserUpdate={vi.fn()} onWorkspaceUpdate={vi.fn()} />
    )
    const pwInputs = container.querySelectorAll('input[type="password"]') // [current, new, confirm]
    await userEvent.type(pwInputs[0]!, 'oldpassword')
    await userEvent.type(pwInputs[1]!, 'newpassword1')
    await userEvent.type(pwInputs[2]!, 'different9')
    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }))

    expect(toast.error).toHaveBeenCalledWith('Passwords do not match')
    // api should not be called for profile/password endpoints due to client-side validation failure
    expect(api).not.toHaveBeenCalledWith('/api/auth/password', expect.anything())
  })

  test('saving the workspace PATCHes and calls onWorkspaceUpdate', async () => {
    const api = makeApi((path, init) => {
      if (path === '/api/workspaces/ws1' && init?.method === 'PATCH')
        return Promise.resolve({ workspace: { ...workspace, name: 'Northwind Co' } })
    })
    const { onWorkspaceUpdate } = renderSettings(api)

    await userEvent.click(screen.getByRole('button', { name: 'Save Workspace' }))
    expect(api).toHaveBeenCalledWith('/api/workspaces/ws1', expect.objectContaining({ method: 'PATCH' }))
    expect(onWorkspaceUpdate).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Workspace updated')
  })

  test('removing a member asks for confirmation via a dialog, then removes them', async () => {
    const member = { id: 'm1', role: 'member' as const, user: { id: 'u2', email: 'jo@northwind.test', name: 'Jo' } }
    const api = makeApi((path, init) => {
      if (path.includes('/members') && init?.method === 'DELETE') return Promise.resolve({})
      if (path.includes('/members')) return Promise.resolve({ members: [member] })
    })
    renderSettings(api, { canManage: true })

    await screen.findByText('Jo')
    await userEvent.click(screen.getByRole('button', { name: '✕' }))
    expect(screen.getByRole('dialog', { name: /Remove member\?/i })).toBeInTheDocument()
    expect(api).not.toHaveBeenCalledWith(expect.stringContaining('/members/u2'), expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/members/u2', expect.objectContaining({ method: 'DELETE' }))
  })

  test('shows warmup ramp status and sender reputation once SMTP is configured', async () => {
    const api = makeApi((path) => {
      if (path.includes('/email-config')) return Promise.resolve({ config: { smtpFrom: 'sales@northwind.test', smtpHost: 'smtp.acme.test' } })
      if (path.includes('/stats/reputation')) return Promise.resolve({
        healthy: false, totalSends: 200, bounces: 20, complaints: 1, bounceRate: 0.1, complaintRate: 0.005,
        reason: 'BOUNCE_RATE_HIGH', thresholds: { windowDays: 7, minSends: 50, maxBounceRate: 0.05, maxComplaintRate: 0.003 },
        guardMode: 'observe',
        warmup: { active: true, startedAt: new Date().toISOString(), day: 2, totalDays: 8, cap: 40, complete: false },
      })
    })
    renderSettings(api, { canManage: true })

    expect(await screen.findByText(/Warming up — day 2 of 8, today's cap: 40\/day/)).toBeInTheDocument()
    expect(await screen.findByText(/BLOCKED — bounce rate too high/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart warmup' })).toBeInTheDocument()
  })

  test('starting warmup posts to the warmup/start endpoint', async () => {
    const api = makeApi((path, init) => {
      if (path.includes('/email-config')) return Promise.resolve({ config: { smtpFrom: 'sales@northwind.test', smtpHost: 'smtp.acme.test' } })
      if (path === '/api/workspaces/ws1/warmup/start' && init?.method === 'POST')
        return Promise.resolve({ warmupStartedAt: new Date().toISOString() })
    })
    renderSettings(api, { canManage: true })

    const startBtn = await screen.findByRole('button', { name: 'Start warmup' })
    await userEvent.click(startBtn)

    expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/warmup/start', expect.objectContaining({ method: 'POST' }))
    expect(toast.success).toHaveBeenCalledWith('Warmup started')
  })

  test('revoking the API key asks for confirmation via a dialog, then revokes it', async () => {
    const wsWithKey = { ...workspace, ingestApiKey: 'whsec_abc' }
    const api = makeApi((path, init) => {
      if (path === '/api/workspaces/ws1/api-key' && init?.method === 'DELETE') return Promise.resolve({})
    })
    renderSettings(api, { canManage: true, workspace: wsWithKey })

    await userEvent.click(screen.getByRole('button', { name: 'Revoke Key' }))
    expect(screen.getByRole('dialog', { name: /Revoke API key\?/i })).toBeInTheDocument()
    expect(api).not.toHaveBeenCalledWith('/api/workspaces/ws1/api-key', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/api-key', expect.objectContaining({ method: 'DELETE' }))
  })
})
