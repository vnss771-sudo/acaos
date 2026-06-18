import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionBuilder } from './MissionBuilder.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

afterEach(() => vi.restoreAllMocks())

// Drive the 4-step wizard to the launch step.
async function fillToLaunch() {
  // Step 1 — target
  expect(screen.getByText('Who do you want to reach?')).toBeInTheDocument()
  await userEvent.type(screen.getByPlaceholderText(/Industrial contractors in Brisbane/i), 'Trades in QLD')
  await userEvent.click(screen.getByRole('button', { name: /Next/ }))
  // Step 2 — offer
  expect(screen.getByText('What do you sell or offer?')).toBeInTheDocument()
  await userEvent.type(screen.getByPlaceholderText(/Fleet maintenance services/i), 'Fleet upkeep')
  await userEvent.click(screen.getByRole('button', { name: /Next/ }))
  // Step 3 — goal (BOOK_CALL is the default selection)
  expect(screen.getByText('What outcome do you want from this mission?')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /Next/ }))
  // Step 4 — name
  expect(screen.getByText('What should this mission be called?')).toBeInTheDocument()
}

describe('MissionBuilder', () => {
  test('Next is disabled until the target question is answered', async () => {
    render(<MissionBuilder workspace={workspace} api={vi.fn() as never} toast={toast as never} onCreated={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/Step 1 of 4/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText(/Industrial contractors in Brisbane/i), 'Trades')
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled()
  })

  test('walks all four steps and prefills the mission name from the target answer', async () => {
    render(<MissionBuilder workspace={workspace} api={vi.fn() as never} toast={toast as never} onCreated={vi.fn()} onClose={vi.fn()} />)
    await fillToLaunch()
    // buildDefaultName() seeds "Q<n> <year> — <target snippet>".
    const nameField = screen.getByPlaceholderText(/Industrial contractors in Brisbane/i) as HTMLInputElement
    expect(nameField.value).toMatch(/Trades in QLD/)
  })

  test('Back returns to the previous step preserving the answer', async () => {
    render(<MissionBuilder workspace={workspace} api={vi.fn() as never} toast={toast as never} onCreated={vi.fn()} onClose={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText(/Industrial contractors in Brisbane/i), 'Trades in QLD')
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Who do you want to reach?')).toBeInTheDocument()
    expect((screen.getByPlaceholderText(/Industrial contractors in Brisbane/i) as HTMLInputElement).value).toBe('Trades in QLD')
  })

  test('Launch POSTs the mission payload and calls onCreated with the campaign', async () => {
    const onCreated = vi.fn()
    const api = vi.fn().mockResolvedValue({ mission: { id: 'm1', name: 'n' }, campaign: { id: 'c1', name: 'Q3 — Trades' } })
    render(<MissionBuilder workspace={workspace} api={api as never} toast={toast as never} onCreated={onCreated} onClose={vi.fn()} />)
    await fillToLaunch()

    await userEvent.click(screen.getByRole('button', { name: 'Launch Mission' }))
    expect(api).toHaveBeenCalledWith('/api/missions', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((api.mock.calls[0][1] as any).body)
    expect(body).toMatchObject({
      workspaceId: 'ws1', goalType: 'BOOK_CALL',
      targetCustomer: 'Trades in QLD', offer: 'Fleet upkeep',
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('c1', 'Q3 — Trades'))
  })

  test('a failed launch surfaces a toast and does not call onCreated', async () => {
    const onCreated = vi.fn()
    const api = vi.fn().mockRejectedValue(new Error('server down'))
    render(<MissionBuilder workspace={workspace} api={api as never} toast={toast as never} onCreated={onCreated} onClose={vi.fn()} />)
    await fillToLaunch()
    await userEvent.click(screen.getByRole('button', { name: 'Launch Mission' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('server down'))
    expect(onCreated).not.toHaveBeenCalled()
  })

  test('the close control invokes onClose', async () => {
    const onClose = vi.fn()
    render(<MissionBuilder workspace={workspace} api={vi.fn() as never} toast={toast as never} onCreated={vi.fn()} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
