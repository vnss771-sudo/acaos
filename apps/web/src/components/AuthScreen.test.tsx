import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthScreen } from './AuthScreen.js'

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch
}

describe('AuthScreen', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { vi.restoreAllMocks() })

  test('defaults to login mode (no name field)', () => {
    render(<AuthScreen onToken={vi.fn()} />)
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Your name')).not.toBeInTheDocument()
  })

  test('switching to Create account reveals the name field', async () => {
    render(<AuthScreen onToken={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument()
  })

  test('submitting login posts credentials, stores the token, and calls onToken', async () => {
    const fetchMock = mockFetch(200, { token: 'jwt-abc', refreshToken: 'ref-xyz' })
    vi.stubGlobal('fetch', fetchMock)
    const onToken = vi.fn()
    const { container } = render(<AuthScreen onToken={onToken} />)

    await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'Sarah@Northwind.test')
    await userEvent.type(screen.getByPlaceholderText('At least 8 characters'), 'hunter2hunter')
    await userEvent.click(container.querySelector('button[type="submit"]')!) // the form submit, not the mode toggle

    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(url).toMatch(/\/api\/auth\/login$/)
    expect(JSON.parse(init.body)).toMatchObject({ email: 'sarah@northwind.test', password: 'hunter2hunter' }) // normalised

    expect(onToken).toHaveBeenCalledWith('jwt-abc', 'ref-xyz')
    expect(localStorage.getItem('acaos_token')).toBe('jwt-abc')
  })

  test('shows the server error message on a failed login', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'Invalid credentials' }))
    const onToken = vi.fn()
    const { container } = render(<AuthScreen onToken={onToken} />)

    await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'a@b.test')
    await userEvent.type(screen.getByPlaceholderText('At least 8 characters'), 'wrongpassword')
    await userEvent.click(container.querySelector('button[type="submit"]')!)

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(onToken).not.toHaveBeenCalled()
  })
})
