import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Sidebar } from './Sidebar.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind Trades', slug: 'northwind', plan: 'free' }

function renderSidebar(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = {
    view: 'dashboard' as const,
    setView: vi.fn(),
    email: 'sarah@northwind.test',
    workspace,
    onLogout: vi.fn(),
    ...over,
  }
  render(<Sidebar {...props} />)
  return props
}

describe('Sidebar', () => {
  test('renders the workspace, email, and all nav items', () => {
    renderSidebar()
    expect(screen.getByText('Northwind Trades')).toBeInTheDocument()
    expect(screen.getByText('sarah@northwind.test')).toBeInTheDocument()
    for (const label of ['Home', 'Analytics', 'Prospects', 'Campaigns', 'Leads', 'AI Tools', 'Billing', 'Settings']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  test('groups the advanced surfaces under headings so the daily loop reads as the primary set', () => {
    renderSidebar()
    expect(screen.getByText('Discover & analyze')).toBeInTheDocument()
    expect(screen.getByText('Account')).toBeInTheDocument()
  })

  test('clicking a nav item calls setView with its id', async () => {
    const { setView } = renderSidebar()
    await userEvent.click(screen.getByText('Prospects'))
    expect(setView).toHaveBeenCalledWith('prospects')
  })

  test('shows the plan label for the workspace', () => {
    renderSidebar({ workspace: { ...workspace, plan: 'growth' } })
    expect(screen.getByText(/Growth plan/i)).toBeInTheDocument()
  })

  test('falls back to the free plan when there is no workspace', () => {
    renderSidebar({ workspace: null })
    expect(screen.getByText(/Free plan/i)).toBeInTheDocument()
  })

  test('Sign out triggers onLogout', async () => {
    const { onLogout } = renderSidebar()
    await userEvent.click(screen.getByText('Sign out'))
    expect(onLogout).toHaveBeenCalledOnce()
  })
})
