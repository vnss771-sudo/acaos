import { describe, test, expect, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { pathForView, viewForPath, useViewRouter } from './router.js'
import type { View } from '../types.js'

function Probe({ fallback = 'dashboard' as View }: { fallback?: View }) {
  const [view, navigate, replace] = useViewRouter(fallback)
  return (
    <div>
      <div data-testid="view">{view}</div>
      <button onClick={() => navigate('leads')}>go leads</button>
      <button onClick={() => navigate('settings')}>go settings</button>
      <button onClick={() => replace('billing')}>replace billing</button>
    </div>
  )
}

afterEach(() => {
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('pathForView / viewForPath', () => {
  test('round-trips every view through its path', () => {
    const views: View[] = ['dashboard', 'leads', 'settings', 'ops-dashboard', 'ops-crew']
    for (const v of views) expect(viewForPath(pathForView(v))).toBe(v)
  })

  test('treats a trailing slash as the same route', () => {
    expect(viewForPath('/leads/')).toBe('leads')
  })

  test('returns null for an unmapped path', () => {
    expect(viewForPath('/no-such-route')).toBeNull()
  })
})

describe('useViewRouter', () => {
  test('initializes from the current URL path', () => {
    window.history.replaceState({}, '', '/settings')
    render(<Probe />)
    expect(screen.getByTestId('view')).toHaveTextContent('settings')
  })

  test('an unrecognized path falls back and rewrites the URL to match', () => {
    window.history.replaceState({}, '', '/not-a-real-page')
    render(<Probe fallback="dashboard" />)
    expect(screen.getByTestId('view')).toHaveTextContent('dashboard')
    expect(window.location.pathname).toBe('/')
  })

  test('navigate pushes a new history entry and updates the URL', async () => {
    window.history.replaceState({}, '', '/')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    render(<Probe />)

    await userEvent.click(screen.getByRole('button', { name: 'go leads' }))
    expect(screen.getByTestId('view')).toHaveTextContent('leads')
    expect(window.location.pathname).toBe('/leads')
    expect(pushSpy).toHaveBeenCalledTimes(1)
  })

  test('navigating to the already-active view is a no-op (no duplicate history entry)', async () => {
    window.history.replaceState({}, '', '/leads')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    render(<Probe />)

    // Clicking "go leads" while already on leads must not push again.
    await userEvent.click(screen.getByRole('button', { name: 'go leads' }))
    expect(pushSpy).not.toHaveBeenCalled()
  })

  test('replace swaps the current entry instead of pushing one', async () => {
    window.history.replaceState({}, '', '/')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    render(<Probe />)

    await userEvent.click(screen.getByRole('button', { name: 'replace billing' }))
    expect(screen.getByTestId('view')).toHaveTextContent('billing')
    expect(window.location.pathname).toBe('/billing')
    expect(pushSpy).not.toHaveBeenCalled()
    // Once for the swap; the initial mount didn't need one since '/' was already valid.
    expect(replaceSpy).toHaveBeenCalledTimes(1)
  })

  test('a popstate event (Back/Forward) updates the view to match the URL', async () => {
    window.history.replaceState({}, '', '/')
    render(<Probe />)
    await userEvent.click(screen.getByRole('button', { name: 'go settings' }))
    expect(screen.getByTestId('view')).toHaveTextContent('settings')

    // Simulate the browser moving the URL back and firing popstate, as Back does.
    window.history.replaceState({}, '', '/')
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByTestId('view')).toHaveTextContent('dashboard')
  })
})
