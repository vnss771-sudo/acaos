import { useCallback, useEffect, useRef, useState } from 'react'
import type { View } from '../types.js'

// Maps every top-level View to a real, linkable URL path and back. This one
// table is what makes the browser's Back/Forward buttons work, a page
// refresh land on the screen the user was looking at instead of always
// resetting to the dashboard, and a screen shareable by URL.
const VIEW_PATHS: Record<View, string> = {
  dashboard: '/',
  intelligence: '/analytics',
  prospects: '/prospects',
  missions: '/missions',
  campaigns: '/campaigns',
  approvals: '/approvals',
  inbox: '/inbox',
  leads: '/leads',
  ai: '/ai',
  billing: '/billing',
  settings: '/settings',
  admin: '/admin',
  'ops-dashboard': '/ops',
  'ops-crew': '/ops/crew',
  'ops-jobs': '/ops/jobs',
  'ops-shifts': '/ops/shifts',
  'ops-roster': '/ops/roster',
  'ops-fatigue': '/ops/fatigue',
  'ops-alerts': '/ops/alerts',
}

const PATH_VIEWS = Object.fromEntries(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View])
) as Record<string, View>

export function pathForView(view: View): string {
  return VIEW_PATHS[view]
}

// A trailing slash (other than the root) is treated as the same route as
// without one — a refresh or a hand-typed URL shouldn't land on the 404 path.
function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

export function viewForPath(pathname: string): View | null {
  return PATH_VIEWS[normalizePath(pathname)] ?? null
}

// Tracks the current top-level view against the real URL: Back/Forward moves
// between views, a refresh reopens the same one, and switching views pushes a
// new history entry so it's linkable. An unrecognized path (a stale link, a
// typo) falls back to `fallback` and rewrites the address bar to match rather
// than leaving a dead URL displayed. `replace(view)` is the same but swaps the
// current history entry instead of pushing one — for a redirect the user
// didn't ask for (an unauthorized route), which shouldn't leave a Back stop.
export function useViewRouter(fallback: View): [View, (v: View) => void, (v: View) => void] {
  const [view, setViewState] = useState<View>(() => {
    const initial = viewForPath(window.location.pathname)
    if (initial === null) window.history.replaceState({}, '', pathForView(fallback))
    return initial ?? fallback
  })
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    function onPopState() {
      setViewState(viewForPath(window.location.pathname) ?? fallback)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [fallback])

  const navigate = useCallback((next: View) => {
    if (viewRef.current === next) return
    window.history.pushState({}, '', pathForView(next))
    setViewState(next)
  }, [])

  const replace = useCallback((next: View) => {
    if (viewRef.current === next) return
    window.history.replaceState({}, '', pathForView(next))
    setViewState(next)
  }, [])

  return [view, navigate, replace]
}
