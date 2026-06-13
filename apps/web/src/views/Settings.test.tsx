import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from './Settings.js'
import type { User, Workspace } from '../types.js'

const user: User = { id: 'u1', email: 'sarah@northwind.test', name: 'Sarah' }
const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'growth', _count: { leads: 42, campaigns: 3 } }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

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
  test('shows the (disabled) email and workspace info', () => {
    renderSettings(vi.fn())
    expect(screen.getByDisplayValue('sarah@northwind.test')).toBeDisabled()
    expect(screen.getByText('42')).toBeInTheDocument()  // total leads
    expect(screen.getByText('Growth')).toBeInTheDocument() // capitalised plan
  })

  test('saving the profile PATCHes and calls onUserUpdate', async () => {
    const api = vi.fn().mockResolvedValue({ user: { ...user, name: 'Sarah C' } })
    const { onUserUpdate } = renderSettings(api)

    await userEvent.clear(screen.getByPlaceholderText('Your name'))
    await userEvent.type(screen.getByPlaceholderText('Your name'), 'Sarah C')
    await userEvent.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(api).toHaveBeenCalledWith('/api/auth/profile', expect.objectContaining({ method: 'PATCH' }))
    expect(onUserUpdate).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Profile updated')
  })

  test('password change is rejected client-side when the confirmation does not match', async () => {
    const api = vi.fn()
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
    expect(api).not.toHaveBeenCalled()
  })

  test('saving the workspace PATCHes and calls onWorkspaceUpdate', async () => {
    const api = vi.fn().mockResolvedValue({ workspace: { ...workspace, name: 'Northwind Co' } })
    const { onWorkspaceUpdate } = renderSettings(api)

    await userEvent.click(screen.getByRole('button', { name: 'Save Workspace' }))
    expect(api).toHaveBeenCalledWith('/api/workspaces/ws1', expect.objectContaining({ method: 'PATCH' }))
    expect(onWorkspaceUpdate).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Workspace updated')
  })
})
