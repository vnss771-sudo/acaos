import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuotingDefaultsSection, parseDefault } from './QuotingDefaultsSection'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

describe('parseDefault', () => {
  test('blank is not set (null), never 0; 0 is 0; out of range or not a number is invalid', () => {
    expect(parseDefault('', 95)).toBeNull()
    expect(parseDefault('  ', 95)).toBeNull()
    expect(parseDefault('0', 95)).toBe(0)
    expect(parseDefault('22.5%', 200)).toBe(22.5)
    expect(parseDefault('96', 95)).toBe('invalid')
    expect(parseDefault('-1', 200)).toBe('invalid')
    expect(parseDefault('abc', 200)).toBe('invalid')
  })
})

describe('QuotingDefaultsSection', () => {
  test('shows saved defaults (blank when not set, 0 when 0) and saves blanks as null', async () => {
    const api = vi.fn((_path: string, init?: { method?: string; body?: string }) => Promise.resolve(
      init?.method === 'PUT' ? { defaults: JSON.parse(init.body!) } : { defaults: { defaultOnCostPct: 20, defaultOverheadPct: 0, defaultTargetMarginPct: null } }))
    render(<QuotingDefaultsSection api={api as never} workspaceId="ws1" toast={toast as never} />)
    expect(await screen.findByLabelText('Labour on-costs (%)')).toHaveValue('20')
    expect(screen.getByLabelText('Overheads (% of direct cost)')).toHaveValue('0')
    expect(screen.getByLabelText('Target gross margin (%)')).toHaveValue('')
    expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/quoting-defaults', { method: 'GET' })

    await userEvent.clear(screen.getByLabelText('Labour on-costs (%)'))
    await userEvent.type(screen.getByLabelText('Target gross margin (%)'), '25')
    await userEvent.click(screen.getByRole('button', { name: 'Save quoting defaults' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Quoting defaults saved'))
    const put = api.mock.calls.find(c => c[1]?.method === 'PUT')!
    expect(put[0]).toBe('/api/workspaces/ws1/quoting-defaults')
    expect(JSON.parse(put[1]!.body!)).toEqual({ defaultOnCostPct: null, defaultOverheadPct: 0, defaultTargetMarginPct: 25 })
  })

  test('an out-of-range value is refused before anything is sent', async () => {
    const api = vi.fn(() => Promise.resolve({ defaults: { defaultOnCostPct: null, defaultOverheadPct: null, defaultTargetMarginPct: null } }))
    render(<QuotingDefaultsSection api={api as never} workspaceId="ws1" toast={toast as never} />)
    await userEvent.type(await screen.findByLabelText('Target gross margin (%)'), '99')
    await userEvent.click(screen.getByRole('button', { name: 'Save quoting defaults' }))
    expect(toast.error).toHaveBeenCalledWith('Target gross margin (%) must be a number from 0 to 95, or blank for no default')
    expect(api.mock.calls.some(c => (c as unknown[])[1] && ((c as unknown[])[1] as { method?: string }).method === 'PUT')).toBe(false)
  })
})
