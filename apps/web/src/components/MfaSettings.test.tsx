import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MfaSettings } from './MfaSettings.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

afterEach(() => vi.restoreAllMocks())

describe('MfaSettings', () => {
  test('shows Disabled status and a Set up 2FA button when disabled', () => {
    const api = vi.fn()
    render(<MfaSettings api={api as never} enabled={false} onEnabledChange={vi.fn()} toast={toast as never} />)
    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up 2FA' })).toBeInTheDocument()
  })

  test('disabling 2FA asks for confirmation via a dialog, then disables it', async () => {
    const api = vi.fn().mockResolvedValue({})
    const onEnabledChange = vi.fn()
    render(<MfaSettings api={api as never} enabled onEnabledChange={onEnabledChange} toast={toast as never} />)

    await userEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }))
    expect(screen.getByRole('dialog', { name: /Disable two-factor authentication\?/i })).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(api).toHaveBeenCalledWith('/api/auth/mfa/disable', expect.objectContaining({ method: 'POST' }))
    expect(onEnabledChange).toHaveBeenCalledWith(false)
  })

  test('cancelling the disable confirmation leaves 2FA enabled', async () => {
    const api = vi.fn().mockResolvedValue({})
    const onEnabledChange = vi.fn()
    render(<MfaSettings api={api as never} enabled onEnabledChange={onEnabledChange} toast={toast as never} />)

    await userEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: /Disable two-factor authentication\?/i })).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
    expect(onEnabledChange).not.toHaveBeenCalled()
  })
})
