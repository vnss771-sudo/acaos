import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from './CommandPalette.js'

function openWithCtrlK() {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
}

beforeEach(() => vi.clearAllMocks())

describe('CommandPalette', () => {
  test('is hidden until a hotkey opens it', () => {
    render(<CommandPalette setView={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    openWithCtrlK()
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument()
  })

  test('"/" opens the palette and Escape closes it', () => {
    render(<CommandPalette setView={vi.fn()} />)
    fireEvent.keyDown(window, { key: '/' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('filters commands and routes on selection', async () => {
    const setView = vi.fn()
    render(<CommandPalette setView={setView} />)
    openWithCtrlK()
    await userEvent.type(screen.getByLabelText('Search commands'), 'review')
    const match = screen.getByText('To Review')
    await userEvent.click(match)
    expect(setView).toHaveBeenCalledWith('approvals')
    // Closes after selection.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('hides the Admin command unless the user is a platform admin', () => {
    const { rerender } = render(<CommandPalette setView={vi.fn()} isAdmin={false} />)
    openWithCtrlK()
    expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    rerender(<CommandPalette setView={vi.fn()} isAdmin />)
    openWithCtrlK()
    expect(screen.getByText('Admin Panel')).toBeInTheDocument()
  })

  test('arrow keys + Enter select the highlighted command', async () => {
    const setView = vi.fn()
    render(<CommandPalette setView={setView} />)
    openWithCtrlK()
    const input = screen.getByLabelText('Search commands')
    // First command is Home (dashboard); ArrowDown moves to Missions.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(setView).toHaveBeenCalledWith('missions')
  })
})
