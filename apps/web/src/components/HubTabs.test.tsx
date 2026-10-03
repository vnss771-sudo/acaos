import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HubTabs } from './HubTabs.js'

describe('HubTabs', () => {
  test('renders the active hub’s tabs and marks the current one selected', () => {
    render(<HubTabs view="leads" setView={vi.fn()} isAdmin={false} />)
    // The Prospects hub: Prospects · Leads · Analytics
    expect(screen.getByRole('tab', { name: 'Campaigns' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Analytics' })).toBeInTheDocument()
    const leads = screen.getByRole('tab', { name: 'Leads' })
    expect(leads).toHaveAttribute('aria-selected', 'true')
  })

  test('selecting a tab routes via setView', async () => {
    const setView = vi.fn()
    render(<HubTabs view="leads" setView={setView} isAdmin={false} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Analytics' }))
    expect(setView).toHaveBeenCalledWith('intelligence')
  })

  test('the Work hub lists the contractor loop in order', () => {
    render(<HubTabs view="ops-find-work" setView={vi.fn()} isAdmin={false} />)
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Find work', 'Clients', 'Jobs & margins'])
    expect(screen.getByRole('tab', { name: 'Find work' })).toHaveAttribute('aria-selected', 'true')
  })

  test('hides the Admin tab from non-admins and shows it to admins', () => {
    const { rerender } = render(<HubTabs view="settings" setView={vi.fn()} isAdmin={false} />)
    expect(screen.queryByRole('tab', { name: 'Admin' })).not.toBeInTheDocument()
    rerender(<HubTabs view="settings" setView={vi.fn()} isAdmin />)
    expect(screen.getByRole('tab', { name: 'Admin' })).toBeInTheDocument()
  })
})
